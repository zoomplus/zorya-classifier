#include <SDL/SDL_video.h>
#include <signal.h>
#include <stdio.h>

int main(void) {
  SDL_Surface *source = SDL_CreateRGBSurface(SDL_SWSURFACE, 768, 336, 32,
                                             0x00ff0000, 0x0000ff00,
                                             0x000000ff, 0xff000000);
  SDL_Surface *destination = SDL_CreateRGBSurface(SDL_SWSURFACE, 800, 600, 32,
                                                   0x00ff0000, 0x0000ff00,
                                                   0x000000ff, 0xff000000);
  SDL_Rect src = {64, 28, 32, 28};
  SDL_Rect dst = {322, 530, 32, 28};
  int status = 1;

  if (source == NULL || destination == NULL) goto done;
  if (SDL_SetColorKey(source, SDL_SRCCOLORKEY, SDL_MapRGB(source->format, 210, 2, 252)) != 0)
    goto done;
  if (SDL_LowerBlit(source, &src, destination, &dst) != 0) goto done;
  if (raise(SIGUSR1) != 0) goto done;
  status = 0;

done:
  if (source != NULL) SDL_FreeSurface(source);
  if (destination != NULL) SDL_FreeSurface(destination);
  if (status != 0) fprintf(stderr, "SDL blit interposition fixture failed\n");
  return status;
}
