import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import gi

gi.require_version('Atspi', '2.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Atspi, GdkPixbuf


def main():
    parser = argparse.ArgumentParser(description='Capture a controlled Geany UI source-geometry proof.')
    parser.add_argument('--output-dir', required=True, type=Path, help='new, empty directory for immutable evidence')
    args = parser.parse_args()
    root = args.output_dir.resolve()
    root.mkdir(mode=0o700)
    source_dir = Path(__file__).resolve().parent
    script_copy = root / 'capture.py'
    with script_copy.open('xb') as output:
        shutil.copyfileobj(Path(__file__).open('rb'), output)
    for filename in ('injected-style.css', 'geany-paint-oracle.c'):
        with (root / filename).open('xb') as output:
            shutil.copyfileobj((source_dir / filename).open('rb'), output)
    subprocess.run([
        'cc', '-shared', '-fPIC', '-O2', '-o', str(root / 'libgeany-paint-oracle.so'),
        str(root / 'geany-paint-oracle.c'), *subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gtk+-3.0'], text=True).split(), '-ldl'
    ], check=True)
    for name in ('capture.png', 'evidence.json', 'stdout.log', 'stderr.log'):
        if (root / name).exists():
            raise RuntimeError(f'refusing overwrite: {name}')
    xdg = root / 'xdg'
    xdg.mkdir(mode=0o700)
    css, shim = root / 'injected-style.css', root / 'libgeany-paint-oracle.so'
    env = os.environ.copy()
    env.update({'GDK_BACKEND':'x11','GDK_SCALE':'1','GTK_MODULES':'gail:atk-bridge','NO_AT_BRIDGE':'0','XDG_CONFIG_HOME':str(xdg),'LD_PRELOAD':str(shim)})
    env.pop('GTK_DEBUG', None)
    openbox = subprocess.Popen(['openbox'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    geany = None
    try:
        time.sleep(.5)
        out = (root / 'stdout.log').open('xb')
        err = (root / 'stderr.log').open('xb')
        geany = subprocess.Popen(['geany','--new-instance','--no-session','--no-plugins','--no-terminal',f'--config={xdg / "geany"}'],env=env,stdout=out,stderr=err)
        deadline = time.time()+20
        window = None
        while time.time()<deadline:
            found=subprocess.run(['xdotool','search','--onlyvisible','--class','geany'],capture_output=True,text=True)
            if found.returncode==0 and found.stdout.strip():
                window=found.stdout.strip().splitlines()[0]; break
            if geany.poll() is not None: raise RuntimeError(f'Geany exited {geany.returncode}')
            time.sleep(.25)
        if not window: raise RuntimeError('Geany window did not appear')
        subprocess.run(['xdotool','windowactivate','--sync',window],check=True)
        subprocess.run(['xdotool','key','ctrl+n'],check=True)
        subprocess.run(['xdotool','type','--clearmodifiers','Controlled Geany oracle screen\nAuthored example content.'],check=True)
        time.sleep(1)
        desktop=Atspi.get_desktop(0)
        tree=[]; buttons=[]
        def walk(node, parent='', depth=0):
            try:
                name=node.get_name() or ''
                role=node.get_role_name() or ''
                state=node.get_state_set()
                visible=state.contains(Atspi.StateType.VISIBLE) if state else None
                showing=state.contains(Atspi.StateType.SHOWING) if state else None
                record={'name':name[:120],'role':role,'parent':parent[:120],'depth':depth,'visible':visible,'showing':showing}
                try:
                    rect=node.get_component().get_extents(Atspi.CoordType.SCREEN)
                    record['bounds']={'x':int(rect.x),'y':int(rect.y),'width':int(rect.width),'height':int(rect.height)}
                except Exception: pass
                if depth < 14 and len(tree)<10000: tree.append(record)
                if role.lower() in ('push button','toggle button','check box','radio button','menu item'):
                    buttons.append(record)
                for i in range(node.get_child_count()):
                    child=node.get_child_at_index(i)
                    if child is not None: walk(child,name or role,depth+1)
            except Exception: return
        for attempt in range(40):
            tree.clear(); buttons.clear(); walk(desktop)
            if any(r['role'].lower()=='push button' and r['name'].strip()=='Save' for r in buttons): break
            time.sleep(.25)
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','x11grab','-video_size','1280x800','-i',os.environ['DISPLAY'],'-frames:v','1','-n',str(root/'capture.png')],check=True)
        pix=GdkPixbuf.Pixbuf.new_from_file(str(root/'capture.png'))
        ch,stride=pix.get_n_channels(),pix.get_rowstride(); pixels=bytes(pix.get_pixels())
        def rgb(x,y):
            i=y*stride+x*ch; return pixels[i],pixels[i+1],pixels[i+2]
        def magenta(p): return p[0]>190 and p[1]<100 and p[2]>190
        def green(p): return p[0]<80 and p[1]>150 and p[2]<110
        for button in buttons:
            b=button.get('bounds')
            if not b: continue
            x,y,w,h=b['x'],b['y'],b['width'],b['height']
            if w<=4 or h<=4 or x<0 or y<0 or x+w>pix.get_width() or y+h>pix.get_height(): continue
            edge=2
            spans={'top':[rgb(xx,yy) for yy in range(y,y+edge) for xx in range(x,x+w)],'bottom':[rgb(xx,yy) for yy in range(y+h-edge,y+h) for xx in range(x,x+w)],'left':[rgb(xx,yy) for yy in range(y+edge,y+h-edge) for xx in range(x,x+edge)],'right':[rgb(xx,yy) for yy in range(y+edge,y+h-edge) for xx in range(x+w-edge,x+w)]}
            coverage={side:sum(map(magenta,vals))/len(vals) for side,vals in spans.items()}
            inner=[rgb(xx,yy) for yy in range(y+edge,y+h-edge) for xx in range(x+edge,x+w-edge)]
            fill=sum(map(green,inner))/len(inner)
            button['paintCheck']={'edgeCoverage':{k:round(v,4) for k,v in coverage.items()},'fillCoverage':round(fill,4),'passes':all(v>=.8 for v in coverage.values())}
        result={'evidenceType':'controlled-real-application-ui','application':'Geany','version':subprocess.run(['geany','--version'],capture_output=True,text=True,check=True).stdout.strip(),'license':'GPL-2.0-or-later','licenseSource':'https://github.com/geany/geany (official source repository README/COPYING)','scene':'private Xvfb 1280x800x24; private XDG profile; GDK_BACKEND=x11; GDK_SCALE=1; unsaved authored editor content','captureSha256':hashlib.sha256((root/'capture.png').read_bytes()).hexdigest(),'captureSize':[pix.get_width(),pix.get_height()],'provider':'owned LD_PRELOAD shim installs GtkCssProvider after GTK init','driverSha256':hashlib.sha256(script_copy.read_bytes()).hexdigest(),'cssSha256':hashlib.sha256(css.read_bytes()).hexdigest(),'shimSourceSha256':hashlib.sha256((root/'geany-paint-oracle.c').read_bytes()).hexdigest(),'shimBinarySha256':hashlib.sha256(shim.read_bytes()).hexdigest(),'tree':tree,'widgets':buttons,'reviewer':'AT-SPI semantic name and widget allocation; per-widget pixel verification against controlled CSS; no model-generated labels; controlled theme, not natural user capture'}
        with (root/'evidence.json').open('x',encoding='utf-8') as evidence:
            evidence.write(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'version':result['version'],'toolbarWidgets':[w for w in buttons if w.get('showing') and w.get('bounds',{}).get('x',-1)>=0 and w['parent'] in ('panel','filler')],'captureSha256':result['captureSha256']},indent=2))
    finally:
        for proc in (geany,openbox):
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=3)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=3)

if __name__ == "__main__":
    main()
