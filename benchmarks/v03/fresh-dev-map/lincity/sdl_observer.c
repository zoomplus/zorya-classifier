#define _GNU_SOURCE
#include <SDL.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef int (*EVPDigestFn)(const void *, size_t, unsigned char *, unsigned int *, const void *, void *);
typedef const void *(*EVPSha256Fn)(void);

typedef struct {
    SDL_Texture *texture;
    SDL_Surface *surface;
    char rgba_sha256[65];
    uint64_t alpha_nonzero;
    uint64_t alpha_partial;
    int alpha_x0;
    int alpha_y0;
    int alpha_x1;
    int alpha_y1;
    int width;
    int height;
    int pixel_hash_status;
} TextureEntry;

typedef struct {
    SDL_Surface *surface;
    void *pixels;
    int width;
    int height;
    int pitch;
    Uint32 format;
    TextureEntry metadata;
    int valid;
} SurfaceEntry;

typedef struct {
    SDL_Renderer *renderer;
    SDL_Surface *surface;
    unsigned int present_count;
} RendererEntry;

static pthread_mutex_t trace_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t trace_once = PTHREAD_ONCE_INIT;
static FILE *trace_file = NULL;
static size_t trace_bytes = 0;
static unsigned int trace_events = 0;
static unsigned int renderer_count = 0;
static TextureEntry texture_entries[16384];
static SurfaceEntry surface_entries[4096];
static RendererEntry renderer_entries[256];
static unsigned int sequence_no = 0;
static unsigned int omitted = 0;
static int recording_enabled = 0;
static int capture_requested = 0;
static int capture_finished = 0;
static int target_draw_seen = 0;
static char capture_control_path[4096];
static char capture_target_rgba_sha256[65] = "a6d5aa264a64eca2fa54cd2e06278d7e96472ece796fda95148a9baeba0900f5";
static void *crypto_handle = NULL;
static EVPDigestFn evp_digest = NULL;
static EVPSha256Fn evp_sha256 = NULL;

#define TRACE_MAX_BYTES (16u * 1024u * 1024u)
#define TRACE_MAX_EVENTS 50000u
#define MAX_HASH_PIXELS 262144u
#define EVP_MAX_MD_SIZE 64u
#define TARGET_FARM0_RGBA_SHA256 "a6d5aa264a64eca2fa54cd2e06278d7e96472ece796fda95148a9baeba0900f5"

static void init_trace(void) {
    const char *path = getenv("ZORYA_LINCITY_TRACE_JSONL");
    const char *control = getenv("ZORYA_LINCITY_CAPTURE_CONTROL");
    const char *target = getenv("ZORYA_LINCITY_TARGET_RGBA_SHA256");
    if (control && *control && strlen(control) < sizeof(capture_control_path)) {
        memcpy(capture_control_path, control, strlen(control) + 1);
    }
    if (target && strlen(target) == 64) {
        int valid = 1;
        for (size_t i = 0; i < 64; i++) {
            if (!((target[i] >= '0' && target[i] <= '9') || (target[i] >= 'a' && target[i] <= 'f'))) {
                valid = 0;
                break;
            }
        }
        if (valid) memcpy(capture_target_rgba_sha256, target, 65);
    }
    if (!path || !*path) return;
    struct stat existing;
    if (lstat(path, &existing) == 0 || errno != ENOENT) return;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) return;
    trace_file = fdopen(fd, "w");
    if (!trace_file) { close(fd); return; }
    crypto_handle = dlopen("libcrypto.so.3", RTLD_NOW | RTLD_LOCAL);
    if (crypto_handle) {
        evp_digest = (EVPDigestFn)dlsym(crypto_handle, "EVP_Digest");
        evp_sha256 = (EVPSha256Fn)dlsym(crypto_handle, "EVP_sha256");
    }
}

static void ensure_trace(void) {
    (void)pthread_once(&trace_once, init_trace);
}

static void emit(const char *payload) {
    if (!trace_file || !payload || !recording_enabled) return;
    size_t len = strlen(payload);
    pthread_mutex_lock(&trace_mutex);
    if (!omitted && (trace_events >= TRACE_MAX_EVENTS || trace_bytes + len + 1 > TRACE_MAX_BYTES)) {
        const char *cap = "{\"type\":\"trace_cap\",\"events\":50000,\"bytes\":16777216}\n";
        (void)fwrite(cap, 1, strlen(cap), trace_file);
        (void)fflush(trace_file);
        omitted = 1;
    }
    if (!omitted) {
        (void)fwrite(payload, 1, len, trace_file);
        (void)fputc('\n', trace_file);
        trace_bytes += len + 1;
        trace_events += 1;
    }
    pthread_mutex_unlock(&trace_mutex);
}

static unsigned int next_sequence(void) {
    unsigned int value;
    pthread_mutex_lock(&trace_mutex);
    value = ++sequence_no;
    pthread_mutex_unlock(&trace_mutex);
    return value;
}

static void hex_sha256(const unsigned char *data, size_t len, char out[65]) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digest_len = 0;
    memset(out, 0, 65);
    if (!evp_digest || !evp_sha256 ||
        evp_digest(data, len, digest, &digest_len, evp_sha256(), NULL) != 1 || digest_len != 32) return;
    static const char hex[] = "0123456789abcdef";
    for (unsigned int i = 0; i < 32; i++) {
        out[i * 2] = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 15];
    }
    out[64] = '\0';
}

static int canonical_surface_rgba(SDL_Surface *surface, char digest[65],
                                  uint64_t *nonzero, uint64_t *partial,
                                  int *x0, int *y0, int *x1, int *y1) {
    if (!surface || !surface->format || surface->w <= 0 || surface->h <= 0) return 0;
    uint64_t pixels = (uint64_t)surface->w * (uint64_t)surface->h;
    if (pixels > MAX_HASH_PIXELS || !evp_digest || !evp_sha256) return 0;
    if (SDL_LockSurface(surface) != 0) return 0;
    size_t byte_count = (size_t)pixels * 4u;
    unsigned char *rgba = (unsigned char *)malloc(byte_count);
    if (!rgba) { SDL_UnlockSurface(surface); return 0; }
    *nonzero = 0; *partial = 0;
    *x0 = surface->w; *y0 = surface->h; *x1 = -1; *y1 = -1;
    unsigned char *out = rgba;
    for (int y = 0; y < surface->h; y++) {
        const unsigned char *row = (const unsigned char *)surface->pixels + (size_t)y * (size_t)surface->pitch;
        for (int x = 0; x < surface->w; x++) {
            Uint32 pixel = 0;
            int bpp = surface->format->BytesPerPixel;
            const unsigned char *src = row + (size_t)x * (size_t)bpp;
            if (bpp == 1) pixel = src[0];
            else if (bpp == 2) { Uint16 v; memcpy(&v, src, sizeof(v)); pixel = v; }
            else if (bpp == 3) {
#if SDL_BYTEORDER == SDL_BIG_ENDIAN
                pixel = ((Uint32)src[0] << 16) | ((Uint32)src[1] << 8) | src[2];
#else
                pixel = src[0] | ((Uint32)src[1] << 8) | ((Uint32)src[2] << 16);
#endif
            } else if (bpp == 4) memcpy(&pixel, src, sizeof(pixel));
            else { free(rgba); SDL_UnlockSurface(surface); return 0; }
            Uint8 r, g, b, a;
            SDL_GetRGBA(pixel, surface->format, &r, &g, &b, &a);
            *out++ = r; *out++ = g; *out++ = b; *out++ = a;
            if (a != 0) {
                (*nonzero)++;
                if (a != 255) (*partial)++;
                if (x < *x0) *x0 = x;
                if (y < *y0) *y0 = y;
                if (x > *x1) *x1 = x;
                if (y > *y1) *y1 = y;
            }
        }
    }
    SDL_UnlockSurface(surface);
    hex_sha256(rgba, byte_count, digest);
    free(rgba);
    return digest[0] != '\0';
}

static TextureEntry *find_texture(SDL_Texture *texture) {
    size_t slot = (((uintptr_t)texture) >> 4) % 16384u;
    return texture_entries[slot].texture == texture ? &texture_entries[slot] : NULL;
}

static RendererEntry *find_renderer(SDL_Renderer *renderer) {
    for (unsigned int i = 0; i < renderer_count; i++) {
        if (renderer_entries[i].renderer == renderer) return &renderer_entries[i];
    }
    return NULL;
}

static void log_texture_create(SDL_Renderer *renderer, SDL_Texture *texture, SDL_Surface *surface) {
    if (!texture || !surface) return;
    TextureEntry entry;
    memset(&entry, 0, sizeof(entry));
    entry.texture = texture;
    entry.surface = surface;
    entry.width = surface->w;
    entry.height = surface->h;
    size_t texture_slot = (((uintptr_t)texture) >> 4) % 16384u;
    size_t surface_slot = (((uintptr_t)surface) >> 4) % 4096u;
    SurfaceEntry *cached = &surface_entries[surface_slot];
    Uint32 format = surface->format ? surface->format->format : 0;
    if (cached->valid && cached->surface == surface && cached->pixels == surface->pixels &&
        cached->width == surface->w && cached->height == surface->h &&
        cached->pitch == surface->pitch && cached->format == format) {
        entry = cached->metadata;
        entry.texture = texture;
        entry.surface = surface;
    } else {
        entry.pixel_hash_status = canonical_surface_rgba(surface, entry.rgba_sha256,
            &entry.alpha_nonzero, &entry.alpha_partial, &entry.alpha_x0, &entry.alpha_y0,
            &entry.alpha_x1, &entry.alpha_y1);
        cached->surface = surface;
        cached->pixels = surface->pixels;
        cached->width = surface->w;
        cached->height = surface->h;
        cached->pitch = surface->pitch;
        cached->format = format;
        cached->metadata = entry;
        cached->valid = 1;
    }
    pthread_mutex_lock(&trace_mutex);
    texture_entries[texture_slot] = entry;
    pthread_mutex_unlock(&trace_mutex);
    char line[1024];
    snprintf(line, sizeof(line),
        "{\"type\":\"texture_create\",\"seq\":%u,\"renderer\":\"%p\",\"texture\":\"%p\",\"surface\":\"%p\",\"width\":%d,\"height\":%d,\"format\":\"%s\",\"rgbaSha256\":\"%s\",\"alphaNonzero\":%llu,\"alphaPartial\":%llu,\"alphaBBox\":[%d,%d,%d,%d]}",
        next_sequence(), (void *)renderer, (void *)texture, (void *)surface,
        surface->w, surface->h, SDL_GetPixelFormatName(surface->format->format),
        entry.pixel_hash_status ? entry.rgba_sha256 : "unavailable",
        (unsigned long long)entry.alpha_nonzero, (unsigned long long)entry.alpha_partial,
        entry.alpha_x0, entry.alpha_y0, entry.alpha_x1 + 1, entry.alpha_y1 + 1);
    emit(line);
}

void SDL_FreeSurface(SDL_Surface *surface) {
    static void (*real_fn)(SDL_Surface *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_FreeSurface");
    if (surface) {
        size_t slot = (((uintptr_t)surface) >> 4) % 4096u;
        if (surface_entries[slot].surface == surface) surface_entries[slot].valid = 0;
    }
    if (real_fn) real_fn(surface);
}

SDL_Renderer *SDL_CreateSoftwareRenderer(SDL_Surface *surface) {
    ensure_trace();
    static SDL_Renderer *(*real_fn)(SDL_Surface *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_CreateSoftwareRenderer");
    SDL_Renderer *renderer = real_fn ? real_fn(surface) : NULL;
    if (renderer && renderer_count < 256) {
        renderer_entries[renderer_count++] = (RendererEntry){renderer, surface, 0};
        char line[512];
        snprintf(line, sizeof(line),
            "{\"type\":\"renderer_software\",\"seq\":%u,\"renderer\":\"%p\",\"surface\":\"%p\",\"width\":%d,\"height\":%d}",
            next_sequence(), (void *)renderer, (void *)surface, surface->w, surface->h);
        emit(line);
    }
    return renderer;
}

SDL_Renderer *SDL_CreateRenderer(SDL_Window *window, int index, Uint32 flags) {
    ensure_trace();
    static SDL_Renderer *(*real_fn)(SDL_Window *, int, Uint32) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_CreateRenderer");
    SDL_Renderer *renderer = real_fn ? real_fn(window, index, flags) : NULL;
    if (renderer && renderer_count < 256) {
        renderer_entries[renderer_count++] = (RendererEntry){renderer, NULL, 0};
        int width = 0, height = 0;
        (void)SDL_GetRendererOutputSize(renderer, &width, &height);
        char line[512];
        snprintf(line, sizeof(line),
            "{\"type\":\"renderer_window\",\"seq\":%u,\"renderer\":\"%p\",\"window\":\"%p\",\"width\":%d,\"height\":%d}",
            next_sequence(), (void *)renderer, (void *)window, width, height);
        emit(line);
    }
    return renderer;
}

SDL_Texture *SDL_CreateTextureFromSurface(SDL_Renderer *renderer, SDL_Surface *surface) {
    ensure_trace();
    static SDL_Texture *(*real_fn)(SDL_Renderer *, SDL_Surface *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_CreateTextureFromSurface");
    SDL_Texture *texture = real_fn ? real_fn(renderer, surface) : NULL;
    log_texture_create(renderer, texture, surface);
    return texture;
}

int SDL_RenderCopy(SDL_Renderer *renderer, SDL_Texture *texture, const SDL_Rect *src, const SDL_Rect *dst) {
    ensure_trace();
    static int (*real_fn)(SDL_Renderer *, SDL_Texture *, const SDL_Rect *, const SDL_Rect *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_RenderCopy");
    int result = real_fn ? real_fn(renderer, texture, src, dst) : -1;
    SDL_Rect clip = {0, 0, 0, 0};
    SDL_Rect actual_src = {0, 0, 0, 0};
    SDL_Rect actual_dst = {0, 0, 0, 0};
    SDL_BlendMode blend = SDL_BLENDMODE_NONE;
    Uint8 alpha = 255;
    int w = 0, h = 0, access = 0;
    Uint32 format = 0;
    (void)SDL_QueryTexture(texture, &format, &access, &w, &h);
    if (src) actual_src = *src; else actual_src = (SDL_Rect){0, 0, w, h};
    if (dst) actual_dst = *dst; else (void)SDL_RenderGetViewport(renderer, &actual_dst);
    (void)SDL_RenderGetClipRect(renderer, &clip);
    (void)SDL_GetTextureAlphaMod(texture, &alpha);
    (void)SDL_GetTextureBlendMode(texture, &blend);
    TextureEntry *entry = find_texture(texture);
    RendererEntry *renderer_entry = find_renderer(renderer);
    if (!recording_enabled && capture_requested && result == 0 && entry && entry->pixel_hash_status &&
        strcmp(entry->rgba_sha256, capture_target_rgba_sha256) == 0 &&
        actual_dst.w > 0 && actual_dst.h > 0 && actual_dst.x < 1024 && actual_dst.y < 768 &&
        actual_dst.x + actual_dst.w > 0 && actual_dst.y + actual_dst.h > 0) {
        target_draw_seen = 1;
    }
    char line[1400];
    snprintf(line, sizeof(line),
        "{\"type\":\"render_copy\",\"seq\":%u,\"frame\":%u,\"renderer\":\"%p\",\"targetSurface\":\"%p\",\"texture\":\"%p\",\"surface\":\"%p\",\"rgbaSha256\":\"%s\",\"alphaNonzero\":%llu,\"alphaPartial\":%llu,\"alphaBBox\":[%d,%d,%d,%d],\"textureWidth\":%d,\"textureHeight\":%d,\"src\":[%d,%d,%d,%d],\"dst\":[%d,%d,%d,%d],\"clip\":[%d,%d,%d,%d],\"alpha\":%u,\"blend\":%d,\"result\":%d}",
        next_sequence(), renderer_entry ? renderer_entry->present_count : 0,
        (void *)renderer, renderer_entry ? (void *)renderer_entry->surface : NULL,
        (void *)texture, entry ? (void *)entry->surface : NULL,
        entry && entry->pixel_hash_status ? entry->rgba_sha256 : "unavailable",
        (unsigned long long)(entry ? entry->alpha_nonzero : 0),
        (unsigned long long)(entry ? entry->alpha_partial : 0),
        entry ? entry->alpha_x0 : 0, entry ? entry->alpha_y0 : 0,
        entry ? entry->alpha_x1 + 1 : 0, entry ? entry->alpha_y1 + 1 : 0,
        w, h, actual_src.x, actual_src.y, actual_src.w, actual_src.h,
        actual_dst.x, actual_dst.y, actual_dst.w, actual_dst.h,
        clip.x, clip.y, clip.w, clip.h, alpha, (int)blend, result);
    emit(line);
    return result;
}

void SDL_RenderPresent(SDL_Renderer *renderer) {
    ensure_trace();
    static void (*real_fn)(SDL_Renderer *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_RenderPresent");
    if (real_fn) real_fn(renderer);
    RendererEntry *entry = find_renderer(renderer);
    if (entry) entry->present_count++;
    if (!recording_enabled && !capture_finished && capture_control_path[0] != '\0') {
        struct stat control_stat;
        if (lstat(capture_control_path, &control_stat) == 0 && S_ISREG(control_stat.st_mode)) {
            capture_requested = 1;
        }
    }
    if (!recording_enabled && capture_requested && target_draw_seen) {
        recording_enabled = 1;
        capture_requested = 0;
        target_draw_seen = 0;
        int width = 0, height = 0;
        (void)SDL_GetRendererOutputSize(renderer, &width, &height);
        char start_line[640];
        snprintf(start_line, sizeof(start_line),
            "{\"type\":\"capture_start\",\"seq\":%u,\"renderer\":\"%p\",\"width\":%d,\"height\":%d,\"frame\":%u,\"readiness\":\"pinned-target-resource-draw\",\"targetRgbaSha256\":\"%s\"}",
            next_sequence(), (void *)renderer, width, height,
            entry ? entry->present_count : 0, capture_target_rgba_sha256);
        emit(start_line);
        return;
    }
    char line[512];
    snprintf(line, sizeof(line),
        "{\"type\":\"render_present\",\"seq\":%u,\"renderer\":\"%p\",\"targetSurface\":\"%p\",\"frame\":%u}",
        next_sequence(), (void *)renderer, entry ? (void *)entry->surface : NULL,
        entry ? entry->present_count : 0);
    emit(line);
    if (recording_enabled) {
        char complete_line[256];
        snprintf(complete_line, sizeof(complete_line),
            "{\"type\":\"capture_complete\",\"seq\":%u,\"renderer\":\"%p\",\"frame\":%u}",
            next_sequence(), (void *)renderer, entry ? entry->present_count : 0);
        emit(complete_line);
        recording_enabled = 0;
        capture_finished = 1;
    }
}

int SDL_RenderFillRect(SDL_Renderer *renderer, const SDL_Rect *rect) {
    ensure_trace();
    static int (*real_fn)(SDL_Renderer *, const SDL_Rect *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_RenderFillRect");
    int result = real_fn ? real_fn(renderer, rect) : -1;
    SDL_Rect actual = rect ? *rect : (SDL_Rect){0, 0, 0, 0};
    Uint8 red = 0, green = 0, blue = 0, alpha = 255;
    (void)SDL_GetRenderDrawColor(renderer, &red, &green, &blue, &alpha);
    char line[512];
    snprintf(line, sizeof(line),
        "{\"type\":\"render_fill_rect\",\"seq\":%u,\"frame\":%u,\"renderer\":\"%p\",\"rect\":[%d,%d,%d,%d],\"alpha\":%u,\"result\":%d}",
        next_sequence(), find_renderer(renderer) ? find_renderer(renderer)->present_count : 0,
        (void *)renderer, actual.x, actual.y, actual.w, actual.h, alpha, result);
    emit(line);
    return result;
}

int SDL_RenderDrawLine(SDL_Renderer *renderer, int x1, int y1, int x2, int y2) {
    ensure_trace();
    static int (*real_fn)(SDL_Renderer *, int, int, int, int) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "SDL_RenderDrawLine");
    int result = real_fn ? real_fn(renderer, x1, y1, x2, y2) : -1;
    Uint8 red = 0, green = 0, blue = 0, alpha = 255;
    (void)SDL_GetRenderDrawColor(renderer, &red, &green, &blue, &alpha);
    char line[512];
    snprintf(line, sizeof(line),
        "{\"type\":\"render_line\",\"seq\":%u,\"frame\":%u,\"renderer\":\"%p\",\"from\":[%d,%d],\"to\":[%d,%d],\"alpha\":%u,\"result\":%d}",
        next_sequence(), find_renderer(renderer) ? find_renderer(renderer)->present_count : 0,
        (void *)renderer, x1, y1, x2, y2, alpha, result);
    emit(line);
    return result;
}

int filledPolygonRGBA(SDL_Renderer *renderer, const Sint16 *vx, const Sint16 *vy,
                      int count, Uint8 red, Uint8 green, Uint8 blue, Uint8 alpha) {
    ensure_trace();
    typedef int (*FilledPolygonFn)(SDL_Renderer *, const Sint16 *, const Sint16 *, int,
                                   Uint8, Uint8, Uint8, Uint8);
    static FilledPolygonFn real_fn = NULL;
    if (!real_fn) real_fn = (FilledPolygonFn)dlsym(RTLD_NEXT, "filledPolygonRGBA");
    int result = real_fn ? real_fn(renderer, vx, vy, count, red, green, blue, alpha) : -1;
    if (count > 0 && vx && vy) {
        int x0 = vx[0], x1 = vx[0], y0 = vy[0], y1 = vy[0];
        for (int i = 1; i < count; i++) {
            if (vx[i] < x0) x0 = vx[i]; if (vx[i] > x1) x1 = vx[i];
            if (vy[i] < y0) y0 = vy[i]; if (vy[i] > y1) y1 = vy[i];
        }
        char line[640];
        snprintf(line, sizeof(line),
            "{\"type\":\"filled_polygon\",\"seq\":%u,\"frame\":%u,\"renderer\":\"%p\",\"bbox\":[%d,%d,%d,%d],\"alpha\":%u,\"result\":%d}",
            next_sequence(), find_renderer(renderer) ? find_renderer(renderer)->present_count : 0,
            (void *)renderer, x0, y0, x1 + 1, y1 + 1, alpha, result);
        emit(line);
    }
    return result;
}

