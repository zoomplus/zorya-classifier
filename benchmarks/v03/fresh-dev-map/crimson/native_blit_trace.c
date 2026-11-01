#define _GNU_SOURCE
#include <SDL/SDL_video.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#define TRACE_LIMIT_BYTES (2 * 1024 * 1024)

typedef int (SDLCALL *lower_blit_fn)(SDL_Surface *, SDL_Rect *, SDL_Surface *, SDL_Rect *);

static int trace_fd = -1;
static int status_fd = -1;
static volatile sig_atomic_t trace_failed = 0;
static volatile sig_atomic_t trace_error_written = 0;

static int append_trace(const char *line, size_t length) {
  struct stat info;
  ssize_t written;

  if (trace_fd < 0) return -1;
  if (fstat(trace_fd, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_size < 0 || (size_t)info.st_size + length > TRACE_LIMIT_BYTES) {
    return -1;
  }
  written = write(trace_fd, line, length);
  return written == (ssize_t)length ? 0 : -1;
}

static void status_line(const char *line, size_t length) {
  if (status_fd >= 0 && write(status_fd, line, length) != (ssize_t)length) trace_failed = 1;
}

static void capture_barrier(int signal_number) {
  static const char complete[] = "{\"event\":\"capture-barrier\",\"complete\":true}\n";
  static const char failed[] = "{\"event\":\"capture-barrier\",\"complete\":false}\n";
  (void)signal_number;
  if (trace_failed) status_line(failed, sizeof(failed) - 1);
  else status_line(complete, sizeof(complete) - 1);
}

__attribute__((constructor)) static void initialize_trace(void) {
  const char *trace_path = getenv("CRIMSON_BLIT_TRACE");
  const char *status_path = getenv("CRIMSON_BLIT_STATUS");
  static const char started[] = "{\"event\":\"trace-start\",\"schema\":1}\n";
  struct sigaction action;

  if (trace_path == NULL || trace_path[0] != '/' || status_path == NULL || status_path[0] != '/') {
    trace_failed = 1;
    return;
  }
  trace_fd = open(trace_path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  status_fd = open(status_path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (trace_fd < 0 || status_fd < 0) {
    trace_failed = 1;
    return;
  }
  status_line(started, sizeof(started) - 1);
  action.sa_handler = capture_barrier;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  if (sigaction(SIGUSR1, &action, NULL) != 0) trace_failed = 1;
}

int SDLCALL SDL_LowerBlit(SDL_Surface *source, SDL_Rect *source_rect,
                          SDL_Surface *destination, SDL_Rect *destination_rect) {
  static lower_blit_fn real_lower_blit = NULL;
  SDL_Rect src_copy = {0, 0, 0, 0};
  SDL_Rect dst_copy = {0, 0, 0, 0};
  int result;

  if (real_lower_blit == NULL) {
    *(void **)(&real_lower_blit) = dlsym(RTLD_NEXT, "SDL_LowerBlit");
    if (real_lower_blit == NULL) return -1;
  }
  if (source_rect != NULL) src_copy = *source_rect;
  if (destination_rect != NULL) dst_copy = *destination_rect;
  result = real_lower_blit(source, source_rect, destination, destination_rect);

  if (source != NULL && destination != NULL && source->format != NULL &&
      ((source->w == 768 && source->h == 336 && (source->flags & SDL_SRCCOLORKEY) != 0) ||
       (destination->w == 800 && destination->h == 600))) {
    char line[384];
    int count = snprintf(line, sizeof(line),
      "{\"event\":\"blit\",\"sourceWidth\":%d,\"sourceHeight\":%d,\"sourceFlags\":%u,\"sourceBytesPerPixel\":%u,"
      "\"sourceRect\":[%d,%d,%d,%d],\"destinationRect\":[%d,%d,%d,%d],"
      "\"destinationWidth\":%d,\"destinationHeight\":%d,\"result\":%d}\n",
      source->w, source->h, (unsigned int)source->flags,
      (unsigned int)source->format->BytesPerPixel,
      src_copy.x, src_copy.y, src_copy.w, src_copy.h,
      dst_copy.x, dst_copy.y, dst_copy.w, dst_copy.h,
      destination != NULL ? destination->w : 0,
      destination != NULL ? destination->h : 0, result);
    if (count <= 0 || (size_t)count >= sizeof(line) || append_trace(line, (size_t)count) != 0) {
      trace_failed = 1;
      if (!trace_error_written) {
        trace_error_written = 1;
        status_line("{\"event\":\"trace-error\"}\n", sizeof("{\"event\":\"trace-error\"}\n") - 1);
      }
    } else {
    }
  }
  return result;
}
