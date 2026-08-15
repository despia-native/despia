package despia.engine

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Deterministically exposes the subscription/publication enqueue race: the first
 * [execute] call blocks before enqueueing, while every later submission enqueues
 * normally. Tests submit the initial/current callback on a worker, enqueue a newer
 * publication on the test thread, then release the first submission.
 */
internal class FirstSubmissionLastExecutor : Executor {
    private val submissions = AtomicInteger(0)
    private val firstEntered = CountDownLatch(1)
    private val releaseFirst = CountDownLatch(1)
    private val queue = ConcurrentLinkedQueue<Runnable>()

    override fun execute(command: Runnable) {
        if (submissions.getAndIncrement() == 0) {
            firstEntered.countDown()
            check(releaseFirst.await(10, TimeUnit.SECONDS)) {
                "timed out waiting to release the first executor submission"
            }
        }
        queue.add(command)
    }

    fun awaitFirstSubmission(): Boolean = firstEntered.await(10, TimeUnit.SECONDS)

    fun releaseFirstSubmission() {
        releaseFirst.countDown()
    }

    fun queuedCount(): Int = queue.size

    fun drain(): Int {
        var count = 0
        while (true) {
            val task = queue.poll() ?: return count
            task.run()
            count += 1
        }
    }
}
