#include <SDL.h>

int main(void) {
    if (SDL_Init(0) != 0) return 10;
    SDL_Surface *target = SDL_CreateRGBSurfaceWithFormat(0, 8, 8, 32, SDL_PIXELFORMAT_RGBA32);
    SDL_Surface *source = SDL_CreateRGBSurfaceWithFormat(0, 2, 2, 32, SDL_PIXELFORMAT_RGBA32);
    if (!target || !source) return 11;
    if (SDL_FillRect(source, NULL, SDL_MapRGBA(source->format, 20, 40, 60, 255)) != 0) return 12;
    SDL_Renderer *renderer = SDL_CreateSoftwareRenderer(target);
    if (!renderer) return 13;
    SDL_Texture *texture = SDL_CreateTextureFromSurface(renderer, source);
    if (!texture) return 14;
    SDL_Rect destination = {1, 2, 2, 2};
    if (SDL_RenderCopy(renderer, texture, NULL, &destination) != 0) return 15;
    SDL_RenderPresent(renderer);
    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_FreeSurface(source);
    SDL_FreeSurface(target);
    SDL_Quit();
    return 0;
}
