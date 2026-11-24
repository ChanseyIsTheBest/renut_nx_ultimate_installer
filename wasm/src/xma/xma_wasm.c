/*
 * sasrt-nx-installer (2026-11-21): culdcept-nx-installer's wasm/src/xma (credit culdcept-nx), with xma_open_raw for
 * SASRT's XMA2 sounds inside Wwise packages (a WEM's data chunk: single-stream 2048-byte packets, the rate and channels
 * from its RIFX fmt chunk; lib/xmop.js), built against sasrt-nx's FFmpeg 4.4 (the port's own xmaframes decoder).
 * XMA2's packet header has the frame count where XMA1 has its sequence number: the walk reads neither, only the first
 * frame offset (bits 6-20) and the skip count (byte 3), at the same places in both.
 *
 * culdcept-nx-installer (2026-11-20): wasm/xma.mjs + xma.wasm, for lib/audio.js's Opus re-encode (.xmo files,
 * culdcept-nx's sdk/include/rex/filesystem/xmo.h). An Xbox 360 XMA1 file's packets and frames walked as culdcept-nx's
 * XMA emulation walks them (sdk/src/audio/xma_context.cpp: GetPacketInfo, ProcessFrame), and its frames decoded in
 * order by the same FFmpeg 4.4 xmaframes decoder (sdk/thirdparty/FFmpeg, wmaprodec.c), fresh at the first frame as the
 * emulation's codec is for a new sound: frame k's samples are what the console port would play for it.
 *
 * One file at a time (a worker each):
 *   xma_open(file, size)    0, or < 0 (below); the file stays the caller's until xma_close
 *   xma_open_raw(data, size, rate, channels)  sasrt-nx-installer: the same for a sound's packets alone (no RIFF: data
 *                           offset 0, no trailer), e.g. an XMA2 WEM's data chunk
 *   xma_info(i)             0 data offset, 1 packets, 2 frames, 3 sample rate, 4 channels, 5 trailer bytes, 6 frames
 *                           whose end is not where the next packet says its first frame starts, 7 the frame an error
 *                           names, 8 the fewest tag bits of a packet a frame starts in (culdcept-nx's
 *                           rex/filesystem/xmo.h XmoTagBits: 72 needed)
 *   xma_frames()            the frame table: frames x 8 bytes (u32 bit position in the data, packet headers counted;
 *                           u16 length in bits; u8 the frame's last bit; u8 0), little-endian
 *   xma_decode(count, out)  the next `count` frames into `out` (512 x channels floats a frame, interleaved): the frames
 *                           decoded, or < 0
 *   xma_close()
 *   xma_malloc / xma_free
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "libavcodec/avcodec.h"

#define PACKET_BYTES 2048
#define PACKET_BITS (PACKET_BYTES * 8)
#define HEADER_BITS 32
#define FRAME_HEADER_BITS 15
#define MAX_FRAME_LENGTH 0x7FFF
#define SAMPLES_PER_FRAME 512

enum {
  E_NOT_RIFF = -1,
  E_NO_CHUNKS = -2,
  E_NOT_XMA1 = -3,
  E_STREAMS = -4,
  E_CHANNELS = -5,
  E_PACKETS = -6,
  E_CODEC = -7,
  E_WALK = -8,
  E_MEMORY = -9,
  E_DECODE = -10,
  E_SAMPLES = -11,
};

static const uint8_t* g_file;
static uint32_t g_size, g_data_offset, g_packets, g_rate, g_channels, g_trailer, g_mismatch, g_error_frame, g_room;
static uint8_t* g_frames;
static uint32_t g_frame_count, g_frame_cap, g_next;
static AVCodecContext* g_ctx;
static AVPacket* g_pkt;
static AVFrame* g_frm;
static uint8_t g_buf[1 + 4096 + AV_INPUT_BUFFER_PADDING_SIZE];

static uint32_t le16(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8); }
static uint32_t le32(const uint8_t* p) { return le16(p) | (le16(p + 2) << 16); }
static const uint8_t* packet(uint32_t p) { return g_file + g_data_offset + (size_t)p * PACKET_BYTES; }
// xma::GetPacketFrameOffset: the first frame that starts in the packet, in bits from the packet's start
static uint32_t first_frame(uint32_t p) {
  const uint8_t* h = packet(p);
  return ((((uint32_t)h[0] & 3) << 13) | ((uint32_t)h[1] << 5) | ((uint32_t)h[2] >> 3)) + HEADER_BITS;
}
static uint32_t skip_count(uint32_t p) { return packet(p)[3]; }

// Bit j of the frame at bit `off` of packet p: past the packet's end it goes on after the header of the packet its
// skip count names (ProcessFrame's GetNextPacket). 0 with *ok cleared past the data's end.
static int frame_bit(uint32_t p, uint32_t off, uint32_t j, int* ok) {
  uint32_t in = off + j;
  while (in >= PACKET_BITS) {
    const uint32_t s = skip_count(p);
    in -= PACKET_BITS;
    p += (s == 0xFF ? 0 : s) + 1;
    in += HEADER_BITS;
    if (p >= g_packets) {
      *ok = 0;
      return 0;
    }
  }
  const uint8_t* d = packet(p);
  return (d[in >> 3] >> (7 - (in & 7))) & 1;
}
static uint32_t frame_bits(uint32_t p, uint32_t off, uint32_t j, uint32_t n, int* ok) {
  uint32_t v = 0;
  for (uint32_t k = 0; k < n; ++k) v = (v << 1) | (uint32_t)frame_bit(p, off, j + k, ok);
  return v;
}
// Where bit j of the frame lands: its packet and bit in it.
static void frame_where(uint32_t p, uint32_t off, uint32_t j, uint32_t* out_p, uint32_t* out_in) {
  uint32_t in = off + j;
  while (in >= PACKET_BITS) {
    const uint32_t s = skip_count(p);
    in -= PACKET_BITS;
    p += (s == 0xFF ? 0 : s) + 1;
    in += HEADER_BITS;
  }
  *out_p = p;
  *out_in = in;
}

static int add_frame(uint32_t pos, uint32_t len, int last) {
  if (g_frame_count == g_frame_cap) {
    const uint32_t cap = g_frame_cap ? g_frame_cap * 2 : 4096;
    uint8_t* f = realloc(g_frames, (size_t)cap * 8);
    if (!f) return 0;
    g_frames = f;
    g_frame_cap = cap;
  }
  uint8_t* e = g_frames + (size_t)g_frame_count * 8;
  e[0] = pos & 0xFF, e[1] = (pos >> 8) & 0xFF, e[2] = (pos >> 16) & 0xFF, e[3] = pos >> 24;
  e[4] = len & 0xFF, e[5] = len >> 8, e[6] = (uint8_t)last, e[7] = 0;
  ++g_frame_count;
  return 1;
}

// culdcept-nx's XmoTagBits (sdk/src/filesystem/xmo.cpp), counting: the bits of packet p that can hold its tag (the
// frames that start in it, after each one's length field and before its last bit, as far as the packet's end; then
// bits 47 up to the bit before its first frame), up to `max`.
static uint32_t tag_room(uint32_t p, uint32_t max) {
  const uint8_t* d = packet(p);
  if (d[3] == 0xFF) return 0;
  const uint32_t first = first_frame(p);
  uint32_t n = 0;
  for (uint32_t off = first; off < PACKET_BITS && n < max;) {
    if (PACKET_BITS - off < FRAME_HEADER_BITS) break;
    uint32_t len = 0;
    for (uint32_t k = 0; k < FRAME_HEADER_BITS; ++k) len = (len << 1) | ((d[(off + k) >> 3] >> (7 - ((off + k) & 7))) & 1);
    if (len == 0 || len == MAX_FRAME_LENGTH) break;
    const uint32_t end = off + len - 1 < PACKET_BITS ? off + len - 1 : PACKET_BITS;
    if (end > off + FRAME_HEADER_BITS) n += end - (off + FRAME_HEADER_BITS);
    if (off + len > PACKET_BITS) break;
    const uint32_t last = (d[(off + len - 1) >> 3] >> (7 - ((off + len - 1) & 7))) & 1;
    off += len;
    if (!last) break;
  }
  const uint32_t stop = first < PACKET_BITS ? first : PACKET_BITS;
  if (stop > HEADER_BITS + FRAME_HEADER_BITS + 1) n += stop - 1 - (HEADER_BITS + FRAME_HEADER_BITS);
  return n < max ? n : max;
}

// GetPacketInfo's walk, packet by packet: from the packet's first frame, frames while each fits and its last bit says
// another follows; a frame (or a frame header) that runs past the packet ends it, and goes on in the next one.
static int walk(void) {
  for (uint32_t p = 0; p < g_packets; ++p) {
    if (skip_count(p) != 0 && skip_count(p) != 0xFF) return E_STREAMS;  // more than one stream's packets interleaved
  }
  for (uint32_t p = 0; p < g_packets; ++p) {
    if (skip_count(p) == 0xFF) continue;  // no frame starts in it
    uint32_t off = first_frame(p);
    while (off < PACKET_BITS) {
      const uint32_t remaining = PACKET_BITS - off;
      int ok = 1;
      const uint32_t len = frame_bits(p, off, 0, FRAME_HEADER_BITS, &ok);
      if (!ok) break;  // a header past the data's end: nothing more
      if (len == 0 || len == MAX_FRAME_LENGTH) break;
      if (len < FRAME_HEADER_BITS + 1) {
        g_error_frame = g_frame_count;
        return E_WALK;
      }
      const int last = frame_bit(p, off, len - 1, &ok);
      if (!ok) {  // the frame runs past the data's end
        g_error_frame = g_frame_count;
        return E_WALK;
      }
      if (!add_frame(p * PACKET_BITS + off, len, last)) return E_MEMORY;
      if (remaining < FRAME_HEADER_BITS || len > remaining) {
        // It ends in a later packet: where that packet's first frame should start.
        uint32_t q, e;
        frame_where(p, off, len, &q, &e);
        // (a last packet that says no frame starts in it, first frame offset past its end, is not a mismatch: the
        // stream's last frame ends there)
        if (q < g_packets && skip_count(q) != 0xFF && first_frame(q) < PACKET_BITS && first_frame(q) != e) ++g_mismatch;
        break;
      }
      off += len;
      if (!last) break;
    }
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE void xma_close(void) {
  if (g_ctx) avcodec_free_context(&g_ctx);
  if (g_pkt) av_packet_free(&g_pkt);
  if (g_frm) av_frame_free(&g_frm);
  free(g_frames);
  g_frames = NULL;
  g_frame_count = g_frame_cap = g_next = 0;
  g_file = NULL;
}

// The packets at [data_at, data_at + data_size) of g_file walked, and the decoder opened (g_rate, g_channels set).
static int open_data(uint32_t data_at, uint32_t data_size) {
  if (data_size % PACKET_BYTES || !data_size) return E_PACKETS;
  g_data_offset = data_at;
  g_packets = data_size / PACKET_BYTES;
  g_trailer = g_size - (data_at + data_size);
  const int w = walk();
  if (w < 0) return w;
  // the tag room of each packet a frame starts in
  for (uint32_t i = 0, last = 0xFFFFFFFF; i < g_frame_count; ++i) {
    const uint32_t p = le32(g_frames + (size_t)i * 8) / PACKET_BITS;
    if (p == last) continue;
    last = p;
    const uint32_t r = tag_room(p, 0xFFFF);
    if (r < g_room) g_room = r;
  }

  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_XMAFRAMES);
  g_ctx = codec ? avcodec_alloc_context3(codec) : NULL;
  g_pkt = av_packet_alloc();
  g_frm = av_frame_alloc();
  if (!g_ctx || !g_pkt || !g_frm) return E_CODEC;
  // as XmaContext::OpenCodec
  g_ctx->sample_rate = (int)g_rate;
  g_ctx->channels = (int)g_channels;
  g_ctx->flags2 |= AV_CODEC_FLAG2_SKIP_MANUAL;
  if (avcodec_open2(g_ctx, codec, NULL) < 0) return E_CODEC;
  return 0;
}

// sasrt-nx-installer (2026-11-21): a sound's packets alone (an XMA2 WEM's data chunk), its rate and channels given.
EMSCRIPTEN_KEEPALIVE int xma_open_raw(const uint8_t* data, uint32_t size, uint32_t rate, uint32_t channels) {
  xma_close();
  g_file = data;
  g_size = size;
  g_mismatch = g_error_frame = 0;
  g_room = 0xFFFFFFFF;
  g_rate = rate;
  g_channels = channels;
  if (g_channels < 1 || g_channels > 2) return E_CHANNELS;
  return open_data(0, size);
}

EMSCRIPTEN_KEEPALIVE int xma_open(const uint8_t* file, uint32_t size) {
  xma_close();
  g_file = file;
  g_size = size;
  g_mismatch = g_error_frame = 0;
  g_room = 0xFFFFFFFF;
  if (size < 12 || memcmp(file, "RIFF", 4) || memcmp(file + 8, "WAVE", 4)) return E_NOT_RIFF;
  const uint8_t* fmt = NULL;
  uint32_t fmt_size = 0, data_at = 0, data_size = 0;
  for (uint32_t at = 12; at + 8 <= size;) {
    const uint32_t cs = le32(file + at + 4);
    if (!memcmp(file + at, "fmt ", 4)) {
      fmt = file + at + 8;
      fmt_size = cs;
    } else if (!memcmp(file + at, "data", 4)) {
      data_at = at + 8;
      data_size = cs;
      break;
    }
    at += 8 + cs + (cs & 1);
  }
  if (!fmt || !data_at || (uint64_t)data_at + data_size > size || fmt_size < 32) return E_NO_CHUNKS;
  // XMAWAVEFORMAT: u16 tag (0x0165), u16 bits, u16 encode options, u16 largest skip, u16 streams, u8 loop count, u8
  // version; then XMASTREAMFORMAT each: u32 pseudo bytes/s, u32 sample rate, u32 loop start, u32 loop end, u8 subframe
  // data, u8 channels, u16 channel mask
  if (le16(fmt) != 0x0165) return E_NOT_XMA1;
  if (le16(fmt + 8) != 1) return E_STREAMS;
  g_rate = le32(fmt + 12 + 4);
  g_channels = fmt[12 + 17];
  if (g_channels < 1 || g_channels > 2) return E_CHANNELS;
  return open_data(data_at, data_size);
}

EMSCRIPTEN_KEEPALIVE uint32_t xma_info(int i) {
  switch (i) {
    case 0: return g_data_offset;
    case 1: return g_packets;
    case 2: return g_frame_count;
    case 3: return g_rate;
    case 4: return g_channels;
    case 5: return g_trailer;
    case 6: return g_mismatch;
    case 7: return g_error_frame;
    case 8: return g_frame_count ? g_room : 0;
    default: return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const uint8_t* xma_frames(void) { return g_frames; }

EMSCRIPTEN_KEEPALIVE int xma_decode(uint32_t count, float* out) {
  if (!g_ctx) return E_CODEC;
  uint32_t done = 0;
  for (; done < count && g_next < g_frame_count; ++done, ++g_next) {
    const uint8_t* e = g_frames + (size_t)g_next * 8;
    const uint32_t pos = le32(e), len = le16(e + 4);
    const uint32_t p = pos / PACKET_BITS, off = pos % PACKET_BITS;
    // the frame's bits from bit 0 of g_buf[1] (ProcessFrame's xma_frame_, here with no padding before it)
    const uint32_t bytes = (len + 7) / 8;
    memset(g_buf, 0, 1 + bytes + AV_INPUT_BUFFER_PADDING_SIZE);
    int ok = 1;
    for (uint32_t j = 0; j < len; ++j) {
      if (frame_bit(p, off, j, &ok)) g_buf[1 + (j >> 3)] |= (uint8_t)(0x80 >> (j & 7));
    }
    const int size = (int)(1 + bytes);
    const uint32_t padding_end = (uint32_t)size * 8 - (8 + len);
    g_buf[0] = (uint8_t)((padding_end & 7) << 2);  // as XmaContext::PreparePacket, padding_start 0
    g_pkt->data = g_buf;
    g_pkt->size = size;
    if (avcodec_send_packet(g_ctx, g_pkt) < 0 || avcodec_receive_frame(g_ctx, g_frm) < 0) {
      g_error_frame = g_next;
      return E_DECODE;
    }
    if (g_frm->nb_samples != SAMPLES_PER_FRAME || g_frm->format != AV_SAMPLE_FMT_FLTP) {
      g_error_frame = g_next;
      return E_SAMPLES;
    }
    float* o = out + (size_t)done * SAMPLES_PER_FRAME * g_channels;
    const float* l = (const float*)g_frm->data[0];
    if (g_channels == 2) {
      const float* r = (const float*)g_frm->data[1];
      for (int i = 0; i < SAMPLES_PER_FRAME; ++i) {
        o[i * 2] = l[i];
        o[i * 2 + 1] = r[i];
      }
    } else {
      memcpy(o, l, SAMPLES_PER_FRAME * sizeof(float));
    }
  }
  return (int)done;
}

EMSCRIPTEN_KEEPALIVE void* xma_malloc(uint32_t size) { return malloc(size); }
EMSCRIPTEN_KEEPALIVE void xma_free(void* p) { free(p); }
