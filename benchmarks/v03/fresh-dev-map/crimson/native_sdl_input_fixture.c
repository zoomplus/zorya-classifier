#include <SDL/SDL.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  SDL_Surface *screen;
  SDL_Event event;
  Uint32 stop_at;

  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "SDL_Init: %s\n", SDL_GetError());
    return 1;
  }
  screen = SDL_SetVideoMode(800, 600, 0, SDL_SWSURFACE);
  if (screen == NULL) {
    fprintf(stderr, "SDL_SetVideoMode: %s\n", SDL_GetError());
    SDL_Quit();
    return 1;
  }
  printf("{\"event\":\"video-mode\",\"bitsPerPixel\":%u,\"bytesPerPixel\":%u,"
         "\"pitch\":%u,\"redMask\":%u,\"greenMask\":%u,\"blueMask\":%u}\n",
         (unsigned int)screen->format->BitsPerPixel,
         (unsigned int)screen->format->BytesPerPixel, (unsigned int)screen->pitch,
         (unsigned int)screen->format->Rmask, (unsigned int)screen->format->Gmask,
         (unsigned int)screen->format->Bmask);
  fflush(stdout);
  stop_at = SDL_GetTicks() + 3000;
  while (SDL_GetTicks() < stop_at) {
    if (SDL_PollEvent(&event)) {
      if (event.type == SDL_KEYDOWN || event.type == SDL_KEYUP) {
        printf("{\"event\":\"%s\",\"ticks\":%u,\"symbol\":%d,\"mod\":%u,\"name\":\"%s\"}\n",
               event.type == SDL_KEYDOWN ? "keydown" : "keyup", (unsigned int)SDL_GetTicks(),
               (int)event.key.keysym.sym, (unsigned int)event.key.keysym.mod,
               SDL_GetKeyName(event.key.keysym.sym));
        fflush(stdout);
      } else if (event.type == SDL_QUIT) {
        break;
      }
    } else {
      usleep(1000);
    }
  }
  SDL_Quit();
  return 0;
}
