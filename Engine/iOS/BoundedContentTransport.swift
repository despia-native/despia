// BoundedContentTransport.swift
//
// Streaming, cancellation-aware URLSession transport for the content store.
// Control-plane responses are accumulated only up to a fixed small ceiling;
// blob responses stream to a temporary file and are cancelled as soon as either
// advertised or observed bytes exceed the configured ceiling.

import Foundation
import Darwin
import CryptoKit

enum DSXContentTransportPolicy {
    static let maximumControlBytes = 4 * 1_024 * 1_024
    static let defaultMaximumBlobMB = 240
    static let minimumMaximumBlobMB = 1
    static let maximumMaximumBlobMB = 2_048

    static func clampedBlobMB(_ configured: Int?) -> Int {
        min(maximumMaximumBlobMB, max(minimumMaximumBlobMB, configured ?? defaultMaximumBlobMB))
    }

    static func blobBytes(_ configuredMB: Int?) -> Int64 {
        Int64(clampedBlobMB(configuredMB)) * 1_024 * 1_024
    }

    static func acceptsAdvertisedLength(_ length: Int64, maximum: Int64) -> Bool {
        length == NSURLSessionTransferSizeUnknown || (length >= 0 && length <= maximum)
    }

    static func acceptsAppend(current: Int64, incoming: Int64, maximum: Int64) -> Bool {
        current >= 0 && incoming >= 0 && current <= maximum && incoming <= maximum - current
    }

    static func allowsRedirect(from sourceURL: URL?, to destinationURL: URL?) -> Bool {
        guard let source = validatedNetworkComponents(sourceURL),
              let destination = validatedNetworkComponents(destinationURL) else { return false }
        return source.scheme != "https" || destination.scheme == "https"
    }

    private static func validatedNetworkComponents(_ url: URL?) -> (scheme: String, host: String)? {
        guard let url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }
        return (scheme, host)
    }
}

enum DSXContentTransportError: Error, Equatable {
    case responseTooLarge
    case incompleteDownload
    case insecureRedirect
}

enum DSXBoundedContentTransport {
    /// A bounded download task with delegate-time advertised/actual byte checks. The delegate
    /// moves URLSession's ephemeral file into caller-owned staging before its callback returns.
    static func download(configuration: URLSessionConfiguration, from url: URL,
                         maximumBytes: Int64, stagingDirectory: URL) async throws -> (URL, URLResponse) {
        precondition(maximumBytes > 0)
        return try await BoundedDownload(
            configuration: configuration, url: url,
            maximumBytes: maximumBytes, stagingDirectory: stagingDirectory
        ).run()
    }
}

/// Shared bounded disk read for control-plane caches and locally-resolved `.dsx` assets.
/// It rejects directories and symlinks, preflights metadata, then reads only one byte beyond the
/// ceiling before rejecting a file that grew after the metadata lookup.
enum DSXBoundedLocalFile {
    static func data(at url: URL, maximumBytes: Int) -> Data? {
        guard maximumBytes >= 0,
              let opened = openRegularFile(at: url, maximumBytes: Int64(maximumBytes)) else { return nil }
        let handle = opened.handle
        defer { try? handle.close() }

        var result = Data()
        if opened.advertisedBytes > 0 { result.reserveCapacity(opened.advertisedBytes) }
        while true {
            let remaining = maximumBytes - result.count
            let count = remaining >= 1_048_576 ? 1_048_576 : remaining + 1
            let chunk: Data
            do {
                chunk = try handle.read(upToCount: count) ?? Data()
            } catch {
                return nil
            }
            guard !chunk.isEmpty else { return result }
            result.append(chunk)
            guard result.count <= maximumBytes else { return nil }
        }
    }

    /// Stream a regular local file into caller-owned staging while computing its identity.
    /// The advertised and observed lengths are both bounded, and no chunk exceeds 1 MiB.
    static func copyAndSHA256(from source: URL, to destination: URL, maximumBytes: Int64) -> String? {
        guard maximumBytes > 0,
              let opened = openRegularFile(at: source, maximumBytes: maximumBytes) else { return nil }
        let input = opened.handle

        // Caller supplies a random staging path, but O_EXCL makes that contract structural:
        // neither an existing file nor a symlink can be truncated or overwritten.
        let destinationDescriptor = Darwin.open(
            destination.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard destinationDescriptor >= 0 else {
            try? input.close()
            return nil
        }
        let output = FileHandle(fileDescriptor: destinationDescriptor, closeOnDealloc: true)
        var completed = false
        defer {
            try? input.close()
            try? output.close()
            if !completed { try? FileManager.default.removeItem(at: destination) }
        }

        var total: Int64 = 0
        var hasher = SHA256()
        do {
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
                guard DSXContentTransportPolicy.acceptsAppend(
                    current: total, incoming: Int64(chunk.count), maximum: maximumBytes
                ) else { return nil }
                total += Int64(chunk.count)
                hasher.update(data: chunk)
                try output.write(contentsOf: chunk)
            }
            try output.synchronize()
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            completed = true
            return digest
        } catch {
            return nil
        }
    }

    /// Open once with no-follow semantics, then validate the descriptor itself. This closes the
    /// metadata/open TOCTOU race for both bounded reads and streamed CAS ingestion.
    private static func openRegularFile(at url: URL,
                                        maximumBytes: Int64) -> (handle: FileHandle, advertisedBytes: Int)? {
        guard maximumBytes >= 0 else { return nil }
        let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_size >= 0,
              status.st_size <= maximumBytes,
              status.st_size <= Int64(Int.max) else {
            Darwin.close(descriptor)
            return nil
        }
        return (
            FileHandle(fileDescriptor: descriptor, closeOnDealloc: true),
            Int(status.st_size)
        )
    }
}

/// Reusable, chunked data-task session. It preserves URLSession protocol caching (including
/// ETag/304), cookies, connection pooling, and redirects while ensuring Foundation never hands
/// the store more than the configured bytes. The task is cancelled on the first oversized chunk.
final class DSXBoundedDataTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private final class Flight {
        let maximum: Int64
        let continuation: CheckedContinuation<(Data, URLResponse), Error>
        var data = Data()
        var response: URLResponse?
        var terminalError: Error?

        init(maximum: Int64, continuation: CheckedContinuation<(Data, URLResponse), Error>) {
            self.maximum = maximum
            self.continuation = continuation
        }
    }

    private final class CancellationToken: @unchecked Sendable {
        private let lock = NSLock()
        private var task: URLSessionTask?
        private var cancelled = false

        func install(_ task: URLSessionTask) {
            lock.lock()
            self.task = task
            let cancelNow = cancelled
            lock.unlock()
            if cancelNow { task.cancel() }
        }

        func cancel() {
            lock.lock()
            cancelled = true
            let task = self.task
            lock.unlock()
            task?.cancel()
        }
    }

    private let lock = NSLock()
    private var flights: [Int: Flight] = [:]
    private var session: URLSession!

    init(configuration: URLSessionConfiguration) {
        super.init()
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func data(from url: URL, maximumBytes: Int) async throws -> (Data, URLResponse) {
        try await data(for: URLRequest(url: url), maximumBytes: maximumBytes)
    }

    /// The arbitrary-method twin used by the native fetch/JSE plane. Keeping it on this
    /// delegate-backed transport is important: `URLSession.data(for:)` accumulates the complete
    /// response before returning and therefore cannot enforce the observed-byte ceiling while a
    /// dishonest or absent Content-Length is still streaming.
    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, URLResponse) {
        precondition(maximumBytes > 0)
        let token = CancellationToken()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = session.dataTask(with: request)
                let flight = Flight(maximum: Int64(maximumBytes), continuation: continuation)
                lock.lock()
                flights[task.taskIdentifier] = flight
                lock.unlock()
                token.install(task)
                task.resume()
            }
        } onCancel: {
            token.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        let allowed = DSXContentTransportPolicy.allowsRedirect(from: response.url, to: request.url)
        if !allowed {
            lock.lock()
            if let flight = flights[task.taskIdentifier], flight.terminalError == nil {
                flight.terminalError = DSXContentTransportError.insecureRedirect
            }
            lock.unlock()
        }
        completionHandler(allowed ? request : nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        guard let flight = flights[dataTask.taskIdentifier] else {
            lock.unlock()
            completionHandler(.cancel)
            return
        }
        flight.response = response
        let allowed = DSXContentTransportPolicy.acceptsAdvertisedLength(
            response.expectedContentLength, maximum: flight.maximum)
        if !allowed { flight.terminalError = DSXContentTransportError.responseTooLarge }
        lock.unlock()
        completionHandler(allowed ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var shouldCancel = false
        lock.lock()
        if let flight = flights[dataTask.taskIdentifier] {
            if DSXContentTransportPolicy.acceptsAppend(
                current: Int64(flight.data.count), incoming: Int64(data.count), maximum: flight.maximum) {
                flight.data.append(data)
            } else {
                if flight.terminalError == nil { flight.terminalError = DSXContentTransportError.responseTooLarge }
                shouldCancel = true
            }
        }
        lock.unlock()
        if shouldCancel { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        lock.lock()
        let flight = flights.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let flight else { return }
        if let terminal = flight.terminalError ?? error {
            flight.continuation.resume(throwing: terminal)
        } else if let response = flight.response {
            flight.continuation.resume(returning: (flight.data, response))
        } else {
            flight.continuation.resume(throwing: DSXContentTransportError.incompleteDownload)
        }
    }
}

private final class BoundedDownload: NSObject, URLSessionDownloadDelegate, URLSessionDataDelegate, @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private let url: URL
    private let maximumBytes: Int64
    private let stagingDirectory: URL
    private let lock = NSLock()

    private var continuation: CheckedContinuation<(URL, URLResponse), Error>?
    private var session: URLSession?
    private var task: URLSessionDownloadTask?
    private var stagedFile: URL?
    private var response: URLResponse?
    private var terminalError: Error?
    private var cancelled = false

    init(configuration: URLSessionConfiguration, url: URL,
         maximumBytes: Int64, stagingDirectory: URL) {
        self.configuration = configuration
        self.url = url
        self.maximumBytes = maximumBytes
        self.stagingDirectory = stagingDirectory
    }

    func run() async throws -> (URL, URLResponse) {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if cancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                let task = session.downloadTask(with: url)
                self.session = session
                self.task = task
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            self.cancel()
        }
    }

    private func cancel() {
        lock.lock()
        cancelled = true
        if terminalError == nil { terminalError = CancellationError() }
        let task = self.task
        lock.unlock()
        task?.cancel()
    }

    private func rejectOversized(_ task: URLSessionTask) {
        lock.lock()
        if terminalError == nil { terminalError = DSXContentTransportError.responseTooLarge }
        lock.unlock()
        task.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        let allowed = DSXContentTransportPolicy.allowsRedirect(from: response.url, to: request.url)
        if !allowed {
            lock.lock()
            if terminalError == nil { terminalError = DSXContentTransportError.insecureRedirect }
            lock.unlock()
        }
        completionHandler(allowed ? request : nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        self.response = response
        let accepted = DSXContentTransportPolicy.acceptsAdvertisedLength(
            response.expectedContentLength, maximum: maximumBytes)
        if !accepted, terminalError == nil { terminalError = DSXContentTransportError.responseTooLarge }
        lock.unlock()
        completionHandler(accepted ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard DSXContentTransportPolicy.acceptsAdvertisedLength(totalBytesExpectedToWrite, maximum: maximumBytes),
              totalBytesWritten >= 0, totalBytesWritten <= maximumBytes else {
            rejectOversized(downloadTask)
            return
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        do {
            let response = downloadTask.response
            guard let response,
                  DSXContentTransportPolicy.acceptsAdvertisedLength(response.expectedContentLength, maximum: maximumBytes) else {
                throw DSXContentTransportError.responseTooLarge
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            let actual = (attributes[.size] as? NSNumber)?.int64Value ?? -1
            guard actual >= 0, actual <= maximumBytes else { throw DSXContentTransportError.responseTooLarge }
            try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
            let destination = stagingDirectory.appendingPathComponent("download-\(UUID().uuidString)")
            try FileManager.default.moveItem(at: location, to: destination)
            lock.lock()
            self.response = response
            self.stagedFile = destination
            lock.unlock()
        } catch {
            lock.lock()
            if terminalError == nil { terminalError = error }
            lock.unlock()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        let staged = stagedFile
        let response = self.response
        let terminal = terminalError ?? error
        self.session = nil
        self.task = nil
        lock.unlock()

        session.finishTasksAndInvalidate()
        guard let continuation else {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            return
        }
        if let terminal {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            continuation.resume(throwing: terminal)
        } else if let staged, let response {
            continuation.resume(returning: (staged, response))
        } else {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            continuation.resume(throwing: DSXContentTransportError.incompleteDownload)
        }
    }
}
