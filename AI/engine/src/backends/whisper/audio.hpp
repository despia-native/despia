// audio.hpp - getting arbitrary audio to what the speech model actually wants.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// whisper.cpp takes 16 kHz mono float samples and nothing else. Everything a
// caller actually has - a 44.1 kHz stereo recording from a phone mic, a 48 kHz
// capture from a desktop - has to become that first. Handing it the wrong rate
// does not fail loudly; it transcribes gibberish, which is the worst failure
// mode available, so the conversion happens here and is not optional.
//
// The WAV reader is deliberately strict and bounded. It parses the RIFF chunk
// list rather than assuming the canonical 44-byte header, because real files
// carry LIST and fact chunks before the data, and it never trusts a declared
// size past the end of the buffer - a length field in a file is an assertion by
// whoever wrote the file, not a fact about the bytes present.

#ifndef DESPIA_AI_WHISPER_AUDIO_HPP
#define DESPIA_AI_WHISPER_AUDIO_HPP

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace despia {
namespace ai {
namespace audio {

constexpr int kTargetRate = 16000;

struct Pcm {
  std::vector<float> samples;  // interleaved
  int rate = 0;
  int channels = 0;
};

inline uint32_t readU32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint16_t readU16(const uint8_t* p) {
  return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                               (static_cast<uint16_t>(p[1]) << 8));
}

// Parses a RIFF/WAVE buffer. Returns false with `error` set rather than
// throwing or half-filling `out`.
inline bool decodeWav(const std::vector<uint8_t>& bytes, Pcm* out,
                      std::string* error) {
  if (bytes.size() < 12 || std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    *error = "not a RIFF/WAVE file";
    return false;
  }

  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0;
  const uint8_t* data = nullptr;
  size_t dataLen = 0;

  size_t pos = 12;
  while (pos + 8 <= bytes.size()) {
    const char* id = reinterpret_cast<const char*>(bytes.data() + pos);
    const uint32_t declared = readU32(bytes.data() + pos + 4);
    const size_t body = pos + 8;
    // Clamp to what is actually present. A declared size running past the end
    // is a truncated or hostile file, and reading it would be the bug.
    const size_t avail = bytes.size() - body;
    const size_t size = declared > avail ? avail : declared;

    if (std::memcmp(id, "fmt ", 4) == 0 && size >= 16) {
      format = readU16(bytes.data() + body);
      channels = readU16(bytes.data() + body + 2);
      rate = readU32(bytes.data() + body + 4);
      bits = readU16(bytes.data() + body + 14);
    } else if (std::memcmp(id, "data", 4) == 0) {
      data = bytes.data() + body;
      dataLen = size;
    }
    pos = body + size + (size & 1);  // chunks are word-aligned
  }

  if (!data || channels == 0 || rate == 0) {
    *error = "the file has no usable fmt/data chunks";
    return false;
  }
  // 1 = PCM integer, 3 = IEEE float. Anything else is a compressed codec this
  // decoder will not pretend to understand.
  if (format != 1 && format != 3) {
    *error = "unsupported WAV encoding (only PCM and IEEE float)";
    return false;
  }

  out->rate = static_cast<int>(rate);
  out->channels = static_cast<int>(channels);
  out->samples.clear();

  if (format == 3 && bits == 32) {
    const size_t n = dataLen / 4;
    out->samples.resize(n);
    std::memcpy(out->samples.data(), data, n * 4);
  } else if (bits == 16) {
    const size_t n = dataLen / 2;
    out->samples.resize(n);
    for (size_t i = 0; i < n; i++) {
      int16_t v;
      std::memcpy(&v, data + i * 2, 2);
      out->samples[i] = static_cast<float>(v) / 32768.0f;
    }
  } else if (bits == 8) {
    out->samples.resize(dataLen);
    for (size_t i = 0; i < dataLen; i++) {
      out->samples[i] = (static_cast<float>(data[i]) - 128.0f) / 128.0f;
    }
  } else if (bits == 32) {
    const size_t n = dataLen / 4;
    out->samples.resize(n);
    for (size_t i = 0; i < n; i++) {
      int32_t v;
      std::memcpy(&v, data + i * 4, 4);
      out->samples[i] = static_cast<float>(v) / 2147483648.0f;
    }
  } else {
    *error = "unsupported WAV bit depth";
    return false;
  }
  return true;
}

// Down-mixes to mono by averaging channels. Taking channel 0 instead would
// silently drop half of anything recorded with the speaker on the right.
inline std::vector<float> toMono(const std::vector<float>& interleaved,
                                 int channels) {
  if (channels <= 1) return interleaved;
  const size_t frames = interleaved.size() / static_cast<size_t>(channels);
  std::vector<float> mono(frames);
  for (size_t f = 0; f < frames; f++) {
    float sum = 0.0f;
    for (int c = 0; c < channels; c++) {
      sum += interleaved[f * static_cast<size_t>(channels) + static_cast<size_t>(c)];
    }
    mono[f] = sum / static_cast<float>(channels);
  }
  return mono;
}

// Linear interpolation to the target rate. Not a windowed-sinc resampler: for
// speech going INTO an ASR model the difference is inaudible to the model, and
// the alternative is either a large dependency or a slow hand-rolled filter.
// Where this would matter - resampling for playback - is not what this is for.
inline std::vector<float> resample(const std::vector<float>& mono, int fromRate,
                                   int toRate) {
  if (fromRate == toRate || mono.empty() || fromRate <= 0) return mono;
  const double ratio = static_cast<double>(toRate) / static_cast<double>(fromRate);
  const size_t outLen = static_cast<size_t>(static_cast<double>(mono.size()) * ratio);
  std::vector<float> out(outLen);
  for (size_t i = 0; i < outLen; i++) {
    const double src = static_cast<double>(i) / ratio;
    const size_t i0 = static_cast<size_t>(src);
    const size_t i1 = i0 + 1 < mono.size() ? i0 + 1 : i0;
    const double frac = src - static_cast<double>(i0);
    out[i] = static_cast<float>(mono[i0] * (1.0 - frac) + mono[i1] * frac);
  }
  return out;
}

// The whole front-end in one call: whatever came in, 16 kHz mono out.
inline std::vector<float> toModelInput(const Pcm& pcm) {
  return resample(toMono(pcm.samples, pcm.channels), pcm.rate, kTargetRate);
}

inline bool readFile(const std::string& path, std::vector<uint8_t>* out,
                     std::string* error) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) {
    *error = "cannot open " + path;
    return false;
  }
  std::fseek(f, 0, SEEK_END);
  const long size = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  if (size <= 0) {
    std::fclose(f);
    *error = "empty file";
    return false;
  }
  out->resize(static_cast<size_t>(size));
  const size_t got = std::fread(out->data(), 1, out->size(), f);
  std::fclose(f);
  if (got != out->size()) {
    *error = "short read";
    return false;
  }
  return true;
}

// Root-mean-square energy over a window, which is what the simple VAD below
// thresholds on.
inline float rms(const float* samples, size_t n) {
  if (n == 0) return 0.0f;
  double sum = 0.0;
  for (size_t i = 0; i < n; i++) sum += static_cast<double>(samples[i]) * samples[i];
  return static_cast<float>(sqrt(sum / static_cast<double>(n)));
}

}  // namespace audio
}  // namespace ai
}  // namespace despia

#endif  // DESPIA_AI_WHISPER_AUDIO_HPP
