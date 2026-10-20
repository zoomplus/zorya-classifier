import json, os, subprocess, sys, time
from pathlib import Path
import gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
root=Path(sys.argv[1]).resolve(); inp=root/'content.txt'; env=os.environ.copy()
env.update({'GDK_BACKEND':'x11','GDK_SCALE':'1','GTK_MODULES':'gail:atk-bridge','NO_AT_BRIDGE':'0','XDG_CONFIG_HOME':str(root/'xdg'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_DATA_HOME':str(root/'data'),'HOME':str(root/'home'),'LD_PRELOAD':str(root/'geom.so'),'A6_GEOM_LOG':str(root/'gtk-widgets.tsv')})
for key in ('HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME'):
 Path(env[key]).mkdir(parents=True,exist_ok=True)
wm=subprocess.Popen(['openbox'],env=env,stdout=open(root/'openbox.log','wb'),stderr=subprocess.STDOUT)
app=None
try:
 time.sleep(.4); app=subprocess.Popen(['mousepad','--disable-server',str(inp)],env=env,stdout=open(root/'app.out','wb'),stderr=open(root/'app.err','wb'))
 time.sleep(2)
 subprocess.run(['xdotool','key','alt+v'],check=True); time.sleep(.3)
 for _ in range(4): subprocess.run(['xdotool','key','Down'],check=True); time.sleep(.05)
 subprocess.run(['xdotool','key','Return'],check=True); time.sleep(1.5)
 rows=[]
 def walk(node, in_toolbar=False):
  try:
   role=(node.get_role_name() or '').lower()
   within_toolbar = in_toolbar or role == 'tool bar'
   if role in ('tool bar','push button'):
    comp=node.get_component(); rect=comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
    rows.append({'name':node.get_name(),'role':role,'toolbarAncestor':within_toolbar if role == 'push button' else None,'extents':None if rect is None else [int(rect.x),int(rect.y),int(rect.width),int(rect.height)],'states':list(node.get_state_set().get_states())})
   for i in range(node.get_child_count()):
    child=node.get_child_at_index(i)
    if child: walk(child, within_toolbar)
  except Exception as e: rows.append({'walkError':type(e).__name__})
 walk(Atspi.get_desktop(0))
 (root/'atspi.json').write_text(json.dumps(rows,sort_keys=True,indent=2)+'\n')
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','x11grab','-video_size','1280x800','-i',os.environ['DISPLAY'],'-frames:v','1','-n',str(root/'frame.png')],check=True)
finally:
 cleanup_errors=[]
 for proc in (app,wm):
  if proc is None or proc.poll() is not None: continue
  try:
   proc.terminate()
   try: proc.wait(timeout=5)
   except subprocess.TimeoutExpired:
    proc.kill(); proc.wait(timeout=5)
  except Exception as e: cleanup_errors.append(f'{proc.args!r}: {type(e).__name__}: {e}')
 if cleanup_errors: (root/'cleanup-errors.txt').write_text('\n'.join(cleanup_errors)+'\n')
