import os, re, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1]).resolve(); positive=sys.argv[2]=='present'; pkg=root.parents[2]/'root'
env=os.environ.copy(); env.update({'LD_LIBRARY_PATH':str(pkg/'usr/lib/x86_64-linux-gnu'),'MINETEST_SUBGAME_PATH':str(pkg/'usr/share/games/minetest/games'),'MINETEST_MOD_PATH':str(pkg/'usr/share/games/minetest/mods'),'MINETEST_WORLD_PATH':str(root/'world'),'MINETEST_USER_PATH':str(root/'profile'),'HOME':str(root/'profile/home')})
Path(env['HOME']).mkdir(parents=True,exist_ok=True)
args=[str(pkg/'usr/games/minetest'),'--go','--world',str(root/'world'),'--gameid','minetest','--name','HeldoutSource','--config',str(root/'minetest.conf'),'--logfile',str(root/'server.log')]
wm=None;proc=None
wm=subprocess.Popen(['openbox'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 time.sleep(.5); proc=subprocess.Popen(args,env=env,stdout=open(root/'stdout.log','wb'),stderr=open(root/'stderr.log','wb'))
 try:
  time.sleep(10)
  found=subprocess.run(['xdotool','search','--onlyvisible','--name','Minetest'],capture_output=True,text=True,check=False); ids=found.stdout.splitlines()
  if not ids: raise RuntimeError('Minetest window missing')
  wid=ids[0]; geo=subprocess.run(['xdotool','getwindowgeometry','--shell',wid],capture_output=True,text=True,check=True).stdout
  vals={k:int(v) for k,v in re.findall(r'^(X|Y|WIDTH|HEIGHT)=(\d+)$',geo,re.M)}
  if vals.get('WIDTH')!=1024: raise RuntimeError(f'unexpected app width {vals}')
  (root/'crop-transform.json').write_text(__import__('json').dumps({'screenWidth':1280,'screenHeight':800,'window':vals,'crop':{'left':vals['X']+864,'top':vals['Y']+29,'width':150,'height':150,'space':'screen pixels'}},sort_keys=True,indent=2)+'\n')
  subprocess.run(['xdotool','windowactivate','--sync',wid],check=False); subprocess.run(['xdotool','mousemove','640','400'],check=False); subprocess.run(['xdotool','key','--clearmodifiers','v'],check=False); time.sleep(2)
  def snap(name):
   full=root/f'frame-{name}.png'
   subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','x11grab','-video_size','1280x800','-i',os.environ['DISPLAY'],'-frames:v','1','-n',str(full)],check=True)
   left=vals['X']+864; top=vals['Y']+29
   crop=root/f'crop-{name}.png'
   subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(full),'-vf',f'crop=150:150:{left}:{top}','-frames:v','1','-n',str(crop)],check=True)
  time.sleep(30); snap('hidden-a')
  if positive:
   for state in ('on','off'):
    subprocess.run(['xdotool','key','--clearmodifiers','t'],check=True); time.sleep(.15); subprocess.run(['xdotool','type','--clearmodifiers',f'oracle_{state}'],check=True); subprocess.run(['xdotool','key','Return'],check=True); time.sleep(15); snap('shown' if state=='on' else 'hidden-b')
  else:
   time.sleep(15); snap('hidden-b')
 finally:
  if proc.poll() is None:
   proc.terminate()
   try: proc.wait(timeout=20)
   except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=3)
finally:
 cleanup_errors=[]
 for owned in (proc,wm):
  if owned is None or owned.poll() is not None: continue
  try:
   owned.terminate()
   try: owned.wait(timeout=5)
   except subprocess.TimeoutExpired:
    owned.kill(); owned.wait(timeout=5)
  except Exception as e: cleanup_errors.append(f'{owned.args!r}: {type(e).__name__}: {e}')
 if cleanup_errors: (root/'cleanup-errors.txt').write_text('\n'.join(cleanup_errors)+'\n')
for line in (root/'server.log').read_text(errors='replace').splitlines():
 if 'ORACLE_CAPTURE_STATE' in line: print(line.split('ORACLE_CAPTURE_STATE ',1)[1])
