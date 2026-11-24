// culdcept-nx-installer (2026-11-20, the user: re-encode the movies to H.265 in the installer): FFmpeg's WMV3 decoder in
// WebAssembly (wasm/wmv3.mjs, built by wasm/src/wmv3/build.sh from the FFmpeg 4.4 of culdcept-nx's
// sdk/thirdparty/FFmpeg, configured with that decoder only). lib/movies.js feeds it a movie's frames as the ASF file holds
// them and hands each picture to the browser's H.265 encoder (WebCodecs) as I420.
//
//   wmv3_open(extradata, size, width, height) -> 0 / < 0      the WMV3 stream's sequence header (the ASF codec data)
//   wmv3_decode(data, size) -> 1 a picture / 0 none / < 0     one frame's payload
//   wmv3_picture() -> pointer to width * height * 3 / 2 bytes   the last picture, I420 (Y, then U, then V, no padding)
//   wmv3_close(); wmv3_malloc(n); wmv3_free(p); wmv3_version()
#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>

extern AVCodec ff_wmv3_decoder;

static AVCodecContext *ctx;
static AVPacket *pkt;
static AVFrame *frame;
static uint8_t *i420;
static int width, height;

EMSCRIPTEN_KEEPALIVE void wmv3_close(void) {
  if (ctx) avcodec_free_context(&ctx);
  if (pkt) av_packet_free(&pkt);
  if (frame) av_frame_free(&frame);
  free(i420);
  i420 = NULL;
}

EMSCRIPTEN_KEEPALIVE int wmv3_open(const uint8_t *extradata, int size, int w, int h) {
  wmv3_close();
  ctx = avcodec_alloc_context3(&ff_wmv3_decoder);
  if (!ctx) return -1;
  ctx->width = ctx->coded_width = width = w;
  ctx->height = ctx->coded_height = height = h;
  ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
  ctx->thread_count = 1;
  if (size > 0) {
    ctx->extradata = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!ctx->extradata) return -2;
    memcpy(ctx->extradata, extradata, size);
    ctx->extradata_size = size;
  }
  if (avcodec_open2(ctx, &ff_wmv3_decoder, NULL) < 0) return -3;
  pkt = av_packet_alloc();
  frame = av_frame_alloc();
  i420 = malloc((size_t)w * h * 3 / 2);
  return pkt && frame && i420 ? 0 : -4;
}

EMSCRIPTEN_KEEPALIVE int wmv3_decode(const uint8_t *data, int size) {
  if (!ctx) return -1;
  av_packet_unref(pkt);
  if (av_new_packet(pkt, size) < 0) return -2;
  memcpy(pkt->data, data, size);
  if (avcodec_send_packet(ctx, pkt) < 0) return -3;
  const int err = avcodec_receive_frame(ctx, frame);
  if (err == AVERROR(EAGAIN)) return 0;
  if (err < 0 || frame->format != AV_PIX_FMT_YUV420P) return -4;
  uint8_t *out = i420;
  for (int k = 0; k < 3; ++k) {
    const int pw = k ? width / 2 : width, ph = k ? height / 2 : height;
    for (int y = 0; y < ph; ++y, out += pw) memcpy(out, frame->data[k] + (size_t)y * frame->linesize[k], pw);
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *wmv3_picture(void) { return i420; }
EMSCRIPTEN_KEEPALIVE void *wmv3_malloc(int n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void wmv3_free(void *p) { free(p); }
EMSCRIPTEN_KEEPALIVE int wmv3_version(void) { return LIBAVCODEC_VERSION_INT; }
