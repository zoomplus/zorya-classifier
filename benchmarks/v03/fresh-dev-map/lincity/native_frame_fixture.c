#include <SDL.h>
#include <string.h>
#include <stdio.h>

static int draw_frame(SDL_Renderer *renderer, SDL_Texture *target) {
    SDL_Rect red = {10, 20, 30, 40};
    SDL_Rect target_rect = {100, 120, 4, 4};
    if (SDL_SetRenderDrawColor(renderer, 12, 34, 56, 255) != 0) return 20;
    if (SDL_RenderClear(renderer) != 0) return 21;
    if (SDL_SetRenderDrawColor(renderer, 210, 20, 30, 255) != 0) return 22;
    if (SDL_RenderFillRect(renderer, &red) != 0) return 23;
    if (SDL_RenderCopy(renderer, target, NULL, &target_rect) != 0) return 24;
    return 0;
}

int main(int argc, char **argv) {
    int width = 800;
    int software = 0;
    int offscreen = 0;
    if (argc > 1 && strcmp(argv[1], "--software") == 0) software = 1;
    if (argc > 1 && strcmp(argv[1], "--width-799") == 0) width = 799;
    if (argc > 1 && strcmp(argv[1], "--offscreen") == 0) offscreen = 1;
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return 10;
    SDL_Window *window = NULL;
    SDL_Surface *window_surface = NULL;
    SDL_Renderer *renderer = NULL;
    if (software) {
        window_surface = SDL_CreateRGBSurfaceWithFormat(0, width, 600, 32, SDL_PIXELFORMAT_RGBA32);
        if (!window_surface) return 11;
        renderer = SDL_CreateSoftwareRenderer(window_surface);
    } else {
        window = SDL_CreateWindow("native-frame-fixture", 0, 0, width, 600, SDL_WINDOW_HIDDEN);
        if (!window) return 11;
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    }
    if (!renderer) return 12;
    SDL_Surface *source = SDL_CreateRGBSurfaceWithFormat(0, 4, 4, 32, SDL_PIXELFORMAT_RGBA32);
    if (!source) return 13;
    if (SDL_FillRect(source, NULL, SDL_MapRGBA(source->format, 90, 80, 70, 255)) != 0) return 14;
    SDL_Texture *target = SDL_CreateTextureFromSurface(renderer, source);
    if (!target) return 15;
    SDL_Texture *render_target = offscreen
        ? SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_TARGET, 800, 600)
        : NULL;
    if (offscreen && !render_target) return 17;

    /* First present observes the explicit control marker; second arms the one selected frame. */
    if (SDL_SetRenderDrawColor(renderer, 1, 2, 3, 255) != 0 || SDL_RenderClear(renderer) != 0) return 16;
    SDL_RenderPresent(renderer);
    int status = draw_frame(renderer, target);
    if (status != 0) return status;
    SDL_RenderPresent(renderer);
    status = draw_frame(renderer, target);
    if (status != 0) return status;
    if (render_target && SDL_SetRenderTarget(renderer, render_target) != 0) return 18;
    SDL_RenderPresent(renderer);

    if (render_target) SDL_DestroyTexture(render_target);
    SDL_DestroyTexture(target);
    SDL_FreeSurface(source);
    SDL_DestroyRenderer(renderer);
    if (window) SDL_DestroyWindow(window);
    if (window_surface) SDL_FreeSurface(window_surface);
    SDL_Quit();
    return 0;
}
