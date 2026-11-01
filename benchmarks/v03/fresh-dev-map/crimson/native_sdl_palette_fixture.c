#include <SDL/SDL.h>
#include <stdio.h>

#define PALETTE_COLORS 126
#define SWATCH_HEIGHT 12

int main(int argc, char **argv) {
  FILE *input;
  unsigned char palette_bytes[PALETTE_COLORS * 3];
  SDL_Color palette[PALETTE_COLORS];
  SDL_Surface *screen = NULL;
  SDL_Surface *indexed = NULL;
  SDL_Surface *converted = NULL;
  int status = 1;

  if (argc != 2 || (input = fopen(argv[1], "rb")) == NULL) {
    fprintf(stderr, "expected a readable 378-byte stock palette file\n");
    return 2;
  }
  if (fread(palette_bytes, 1, sizeof(palette_bytes), input) != sizeof(palette_bytes) ||
      fgetc(input) != EOF) {
    fprintf(stderr, "stock palette input must contain exactly 378 bytes\n");
    fclose(input);
    return 2;
  }
  fclose(input);
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "SDL_Init: %s\n", SDL_GetError());
    return 1;
  }
  screen = SDL_SetVideoMode(800, 600, 16, SDL_SWSURFACE);
  indexed = SDL_CreateRGBSurface(SDL_SWSURFACE, PALETTE_COLORS, SWATCH_HEIGHT, 8,
                                 0, 0, 0, 0);
  if (screen == NULL || indexed == NULL) {
    fprintf(stderr, "SDL surface creation: %s\n", SDL_GetError());
    goto done;
  }
  for (int index = 0; index < PALETTE_COLORS; ++index) {
    palette[index].r = palette_bytes[index * 3];
    palette[index].g = palette_bytes[index * 3 + 1];
    palette[index].b = palette_bytes[index * 3 + 2];
    palette[index].unused = 0;
  }
  if (SDL_SetColors(indexed, palette, 0, PALETTE_COLORS) != 1) {
    fprintf(stderr, "SDL_SetColors: %s\n", SDL_GetError());
    goto done;
  }
  for (int y = 0; y < SWATCH_HEIGHT; ++y) {
    Uint8 *row = (Uint8 *)indexed->pixels + y * indexed->pitch;
    for (int index = 0; index < PALETTE_COLORS; ++index) row[index] = (Uint8)index;
  }
  if (SDL_SetColorKey(indexed, SDL_SRCCOLORKEY, 0) != 0) {
    fprintf(stderr, "SDL_SetColorKey: %s\n", SDL_GetError());
    goto done;
  }
  converted = SDL_DisplayFormat(indexed);
  if (converted == NULL) {
    fprintf(stderr, "SDL_DisplayFormat: %s\n", SDL_GetError());
    goto done;
  }
  SDL_FillRect(screen, NULL, SDL_MapRGB(screen->format, 13, 17, 19));
  for (int index = 0; index < PALETTE_COLORS; ++index) {
    SDL_Rect swatch = {index, 0, 1, SWATCH_HEIGHT};
    Uint32 source_pixel = *((Uint16 *)((Uint8 *)converted->pixels +
                              (6 * converted->pitch) +
                              (index * converted->format->BytesPerPixel)));
    Uint32 display_pixel;
    Uint8 source_red, source_green, source_blue;
    Uint8 display_red, display_green, display_blue;
    if (SDL_BlitSurface(converted, &swatch, screen, &swatch) != 0) {
      fprintf(stderr, "SDL_BlitSurface at palette index %d: %s\n", index, SDL_GetError());
      goto done;
    }
    display_pixel = *((Uint16 *)((Uint8 *)screen->pixels + (6 * screen->pitch) +
                                   (index * screen->format->BytesPerPixel)));
    SDL_GetRGB(source_pixel, converted->format, &source_red, &source_green, &source_blue);
    SDL_GetRGB(display_pixel, screen->format, &display_red, &display_green, &display_blue);
    printf("{\"index\":%d,\"inputRGB\":[%u,%u,%u],\"nativePixel\":%u,"
           "\"nativeRGB\":[%u,%u,%u],\"screenSurfaceRGB\":[%u,%u,%u],"
           "\"colorkeyCollision\":%s}\n",
           index, (unsigned int)palette_bytes[index * 3],
           (unsigned int)palette_bytes[index * 3 + 1], (unsigned int)palette_bytes[index * 3 + 2],
           (unsigned int)source_pixel,
           (unsigned int)source_red, (unsigned int)source_green, (unsigned int)source_blue,
           (unsigned int)display_red, (unsigned int)display_green, (unsigned int)display_blue,
           source_pixel == converted->format->colorkey ? "true" : "false");
  }
  printf("{\"event\":\"formats\",\"indexedBitsPerPixel\":%u,\"indexedBytesPerPixel\":%u,"
         "\"convertedBitsPerPixel\":%u,\"convertedBytesPerPixel\":%u,\"convertedPitch\":%u,"
         "\"convertedRedMask\":%u,\"convertedGreenMask\":%u,\"convertedBlueMask\":%u,"
         "\"screenBitsPerPixel\":%u,\"screenBytesPerPixel\":%u,\"screenPitch\":%u,"
         "\"screenRedMask\":%u,\"screenGreenMask\":%u,\"screenBlueMask\":%u}\n",
         (unsigned int)indexed->format->BitsPerPixel, (unsigned int)indexed->format->BytesPerPixel,
         (unsigned int)converted->format->BitsPerPixel, (unsigned int)converted->format->BytesPerPixel,
         (unsigned int)converted->pitch, (unsigned int)converted->format->Rmask,
         (unsigned int)converted->format->Gmask, (unsigned int)converted->format->Bmask,
         (unsigned int)screen->format->BitsPerPixel, (unsigned int)screen->format->BytesPerPixel,
         (unsigned int)screen->pitch, (unsigned int)screen->format->Rmask,
         (unsigned int)screen->format->Gmask, (unsigned int)screen->format->Bmask);
  fflush(stdout);
  SDL_UpdateRect(screen, 0, 0, PALETTE_COLORS, SWATCH_HEIGHT);
  SDL_Delay(2000);
  status = 0;

done:
  if (converted != NULL) SDL_FreeSurface(converted);
  if (indexed != NULL) SDL_FreeSurface(indexed);
  if (screen != NULL) SDL_FreeSurface(screen);
  SDL_Quit();
  return status;
}
