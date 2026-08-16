// audio_test.cpp - the speech front-end, tested where it is cheap.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// Transcription needs weights; getting audio INTO the right shape does not. And
// this is where the nasty bugs live, because a WAV file is attacker-controlled
// input with length fields in it, and because a resampling mistake produces
// perfectly valid audio that simply transcribes wrong. Neither failure is loud.
//
// So: the chunk walker is tested against files that are not the canonical
// 44-byte layout, against a declared length that runs past the buffer, and
// against encodings it must refuse rather than guess at.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/backends/whisper/audio.hpp"

namespace audio = despia::ai::audio;

namespace {

int g_failures = 0;

void check(bool cond, const char* what) {
  if (cond) {
    std::printf("  ok   %s\n", what);
  } else {
    std::printf("  FAIL %s\n", what);
    g_failures++;
  }
}

void putU32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back(static_cast<uint8_t>(x & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 16) & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 24) & 0xFF));
}

void putU16(std::vector<uint8_t>& v, uint16_t x) {
  v.push_back(static_cast<uint8_t>(x & 0xFF));
  v.push_back(static_cast<uint8_t>((x >> 8) & 0xFF));
}

void putTag(std::vector<uint8_t>& v, const char* tag) {
  for (int i = 0; i < 4; i++) v.push_back(static_cast<uint8_t>(tag[i]));
}

// Builds a 16-bit PCM WAV. `extraChunk` inserts a LIST chunk before `data`,
// which is what real recorders emit and what a fixed-offset reader gets wrong.
std::vector<uint8_t> makeWav(const std::vector<int16_t>& samples, int rate,
                             int channels, bool extraChunk = false,
                             uint32_t dataSizeOverride = 0) {
  std::vector<uint8_t> v;
  putTag(v, "RIFF");
  putU32(v, 0);  // patched below
  putTag(v, "WAVE");

  putTag(v, "fmt ");
  putU32(v, 16);
  putU16(v, 1);                                   // PCM
  putU16(v, static_cast<uint16_t>(channels));
  putU32(v, static_cast<uint32_t>(rate));
  putU32(v, static_cast<uint32_t>(rate * channels * 2));
  putU16(v, static_cast<uint16_t>(channels * 2));
  putU16(v, 16);                                  // bits

  if (extraChunk) {
    putTag(v, "LIST");
    putU32(v, 4);
    putTag(v, "INFO");
  }

  putTag(v, "data");
  const uint32_t dataBytes = static_cast<uint32_t>(samples.size() * 2);
  putU32(v, dataSizeOverride ? dataSizeOverride : dataBytes);
  for (int16_t s : samples) putU16(v, static_cast<uint16_t>(s));

  const uint32_t riff = static_cast<uint32_t>(v.size() - 8);
  v[4] = static_cast<uint8_t>(riff & 0xFF);
  v[5] = static_cast<uint8_t>((riff >> 8) & 0xFF);
  v[6] = static_cast<uint8_t>((riff >> 16) & 0xFF);
  v[7] = static_cast<uint8_t>((riff >> 24) & 0xFF);
  return v;
}

}  // namespace

int main() {
  std::printf("audio_test\n");

  // ── the ordinary case ──────────────────────────────────────────────────────
  {
    std::vector<int16_t> pcm{0, 16384, -16384, 32767};
    audio::Pcm out;
    std::string err;
    const bool ok = audio::decodeWav(makeWav(pcm, 16000, 1), &out, &err);
    check(ok && err.empty(), "a 16-bit mono WAV decodes");
    check(out.rate == 16000 && out.channels == 1, "rate and channels are read");
    check(out.samples.size() == 4, "every frame survives");
    check(std::fabs(out.samples[1] - 0.5f) < 0.01f,
          "16-bit samples are normalised to about plus/minus one");
  }

  // ── the chunk walker, which is the reason this is not a fixed-offset read ──
  {
    std::vector<int16_t> pcm{100, 200, 300};
    audio::Pcm out;
    std::string err;
    const bool ok = audio::decodeWav(makeWav(pcm, 44100, 1, true), &out, &err);
    check(ok && out.samples.size() == 3,
          "a LIST chunk before data does not break the parse");
  }

  // ── hostile input: a declared size past the end of the buffer ─────────────
  {
    // The file says the data chunk holds a megabyte; it holds six bytes. A
    // reader that trusts the field walks off the end.
    std::vector<int16_t> pcm{1, 2, 3};
    audio::Pcm out;
    std::string err;
    const bool ok = audio::decodeWav(makeWav(pcm, 16000, 1, false, 1000000),
                                     &out, &err);
    check(ok && out.samples.size() == 3,
          "a data size running past the buffer is clamped, not trusted");
  }

  // ── refusals ───────────────────────────────────────────────────────────────
  {
    audio::Pcm out;
    std::string err;
    std::vector<uint8_t> junk{'N', 'O', 'P', 'E', 0, 0, 0, 0, 'X', 'X', 'X', 'X'};
    check(!audio::decodeWav(junk, &out, &err) && !err.empty(),
          "a non-RIFF buffer is refused");
  }
  {
    audio::Pcm out;
    std::string err;
    std::vector<uint8_t> tiny{'R', 'I', 'F', 'F'};
    check(!audio::decodeWav(tiny, &out, &err), "a truncated header is refused");
  }
  {
    // Encoding 2 is ADPCM. Decoding it as PCM would produce noise that looks
    // like audio, so it is refused rather than guessed at.
    std::vector<uint8_t> v = makeWav({1, 2}, 16000, 1);
    v[20] = 2;  // the fmt chunk's audioFormat field
    audio::Pcm out;
    std::string err;
    check(!audio::decodeWav(v, &out, &err) && err.find("encoding") != std::string::npos,
          "a compressed encoding is refused rather than misread as PCM");
  }

  // ── down-mix averages, it does not drop a channel ──────────────────────────
  {
    // Left silent, right loud. Taking channel 0 would report silence.
    std::vector<float> stereo{0.0f, 1.0f, 0.0f, 1.0f};
    const std::vector<float> mono = audio::toMono(stereo, 2);
    check(mono.size() == 2 && std::fabs(mono[0] - 0.5f) < 0.001f,
          "down-mix averages the channels rather than taking the first");
  }

  // ── resampling ─────────────────────────────────────────────────────────────
  {
    std::vector<float> in(44100, 0.5f);
    const std::vector<float> out = audio::resample(in, 44100, 16000);
    check(out.size() == 16000, "one second at 44.1 kHz becomes one second at 16 kHz");
    check(std::fabs(out[8000] - 0.5f) < 0.01f, "a constant signal stays constant");
  }
  {
    std::vector<float> in{0.1f, 0.2f, 0.3f};
    check(audio::resample(in, 16000, 16000).size() == 3,
          "resampling to the same rate is a pass-through");
  }
  {
    check(audio::resample({}, 44100, 16000).empty(), "empty audio resamples to empty");
  }

  // ── the whole front-end, end to end ────────────────────────────────────────
  {
    // 44.1 kHz stereo in, 16 kHz mono out - the actual phone-recording path.
    std::vector<int16_t> interleaved;
    for (int i = 0; i < 44100; i++) {
      interleaved.push_back(0);
      interleaved.push_back(16384);
    }
    audio::Pcm pcm;
    std::string err;
    audio::decodeWav(makeWav(interleaved, 44100, 2), &pcm, &err);
    const std::vector<float> ready = audio::toModelInput(pcm);
    check(ready.size() == 16000,
          "44.1 kHz stereo becomes 16 kHz mono at the right length");
    check(std::fabs(ready[8000] - 0.25f) < 0.02f,
          "and the averaged signal level survives the trip");
  }

  // ── the VAD's own measure ──────────────────────────────────────────────────
  {
    std::vector<float> quiet(1000, 0.0f);
    std::vector<float> loud(1000, 0.5f);
    check(audio::rms(quiet.data(), quiet.size()) < 0.001f, "silence reads as silent");
    check(std::fabs(audio::rms(loud.data(), loud.size()) - 0.5f) < 0.01f,
          "a constant signal's RMS is its own level");
    check(audio::rms(nullptr, 0) == 0.0f, "empty audio has no energy and does not divide by zero");
  }

  if (g_failures == 0) {
    std::printf("\nall checks passed\n");
    return 0;
  }
  std::printf("\n%d failure(s)\n", g_failures);
  return 1;
}
