"""Build a private Mousepad FreshTruth file from independent GTK/paint evidence."""
import hashlib
import json
import subprocess
import sys
import re
from pathlib import Path

MAGENTA=bytes((255,0,255))
GREEN=bytes((0,208,32))


def painted_body(raw: bytes, width: int, height: int, bounds: tuple[int,int,int,int]) -> dict:
    left,top,w,h=bounds
    if len(raw)!=width*height*4 or w<5 or h<5 or left<0 or top<0 or left+w>width or top+h>height:
        raise ValueError('invalid RGBA frame or widget bounds')
    def rgb(x,y):
        i=(y*width+x)*4
        return raw[i:i+3]
    edges=[]
    for x in range(left,left+w): edges.extend((rgb(x,top),rgb(x,top+h-1)))
    for y in range(top+1,top+h-1): edges.extend((rgb(left,y),rgb(left+w-1,y)))
    if any(pixel!=MAGENTA for pixel in edges): raise ValueError('painted border is not complete on all four allocation edges')
    fill=0
    for y in range(top+2,top+h-2):
        for x in range(left+2,left+w-2): fill+=rgb(x,y)==GREEN
    if fill < (w-4)*(h-4)*0.6: raise ValueError('opaque controlled fill does not cover button interior')
    return {'fourEdgesCssBorderPixels':len(edges),'cssFillPixels':fill,'paintedPixelBounds':[left,top,left+w-1,top+h-1]}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_truth(rows: list[dict]) -> list[dict]:
    result=[]
    for row in rows:
        boxes=[]
        if row['expectedPresence']=='present':
            r=row['region'];boxes=[{'xyxy':[r['left']/1280,r['top']/800,(r['left']+r['width'])/1280,(r['top']+r['height'])/800]}]
        result.append({'caseId':row['caseId'],'expectedPresence':row['expectedPresence'],'targetBoxes':boxes,
            'negativeEvidence':None if boxes else 'The complete Mousepad toolbar action inventory was read from the app accessibility tree; this action is absent from the toolbar.'})
    return result


def main(root: Path) -> None:
    root=root.resolve();plan=json.loads((root/'caseplan.json').read_text());cases=[];ledger=[]
    expected_names=['New','Open...','Save','Save As...','Reload','Close Tab','Undo','Redo','Cut','Copy','Paste','Find','Find and Replace...','Go to...','Fullscreen']
    allowed_actions=set(expected_names+['Print','Spell Check','Toggle Line Numbers','Zoom In','Zoom Out'])
    specs=plan.get('cases',[])
    ids=[x.get('caseId') for x in specs]
    if len(specs)!=20 or len(set(ids))!=20 or any(not re.fullmatch(r'mousepad-ui-v3-[0-9]{2}',x or '') for x in ids):
        raise SystemExit('unexpected or duplicate UI case IDs')
    for spec in plan['cases']:
        cid=spec['caseId'];d=root/cid;img=d/'frame.png'
        if (d/'cleanup-errors.txt').exists(): raise SystemExit(f'owned process cleanup failed {cid}')
        if spec.get('expectedPresence') not in ('present','absent') or spec.get('action') not in allowed_actions:
            raise SystemExit(f'invalid authored target descriptor {cid}')
        if (spec['action'] in expected_names) != (spec['expectedPresence']=='present'):
            raise SystemExit(f'target presence conflicts with authored toolbar action inventory {cid}')
        raw=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(img),'-f','rawvideo','-pix_fmt','rgba','-'],capture_output=True,check=True).stdout
        if len(raw)!=1280*800*4:raise SystemExit(f'image dimensions mismatch {cid}')
        ui=json.loads((d/'atspi.json').read_text());bars=[r for r in ui if r.get('role')=='tool bar'];buttons=[r for r in ui if r.get('role')=='push button']
        if any('walkError' in r for r in ui):raise SystemExit(f'AT-SPI traversal incomplete {cid}')
        names=[r['name'] for r in buttons]
        if len(bars)!=1 or names!=expected_names:raise SystemExit(f'tool inventory mismatch {cid}: {names}')
        if any(r.get('toolbarAncestor') is not True for r in buttons):raise SystemExit(f'button escaped sole toolbar scope {cid}')
        by={r['name']:r for r in buttons};target=spec['action'];present=target in by
        if present != (spec['expectedPresence']=='present'):raise SystemExit(f'action presence mismatch {cid}')
        row={'caseId':cid,'imageSha256':hashlib.sha256(img.read_bytes()).hexdigest(),'target':target,'expectedPresence':spec['expectedPresence'],'toolbarButtonNames':names}
        if present:
            if by[target].get('toolbarAncestor') is not True:raise SystemExit(f'target is outside the sole toolbar {cid}')
            left,top,w,h=by[target]['extents']
            if left<0 or top<0 or w<=0 or h<=0 or left+w>1280 or top+h>800:raise SystemExit(f'bad bounds {cid}')
            try: evidence=painted_body(raw,1280,800,(left,top,w,h))
            except ValueError as e:raise SystemExit(f'paint proof failed {cid}: {e}')
            row['region']={'left':left,'top':top,'width':w,'height':h}
            row['paintEvidence']={'allocationContainsPaint':True,**evidence}
        cases.append(row)
        ledger.append({'caseId':cid,'imageSha256':row['imageSha256'],'atspiSha256':sha(d/'atspi.json'),'gtkWidgetGeometrySha256':sha(d/'gtk-widgets.tsv'),'captureLogSha256':sha(d/'capture.stdout'),'appStdoutSha256':sha(d/'app.out'),'appStderrSha256':sha(d/'app.err')})
    counts={kind:sum(x['expectedPresence']==kind for x in cases) for kind in ('present','absent')}
    if len(cases)!=20 or counts!={'present':15,'absent':5}:raise SystemExit(f'unexpected UI cardinality: {len(cases)} {counts}')
    if len({x['imageSha256'] for x in cases})!=20:raise SystemExit('duplicate UI screenshot bytes')
    out={'schemaVersion':'mousepad-ui-oracle-truth-v1','sourceGroup':plan['sourceGroup'],'cases':cases}
    path=root/'source-truth.json'
    with path.open('x') as f:json.dump(out,f,sort_keys=True,indent=2);f.write('\n')
    fresh_path=root/'truth.json';fresh=canonical_truth(cases)
    with fresh_path.open('x') as f:json.dump(fresh,f,sort_keys=True,indent=2);f.write('\n')
    license_path=Path('/usr/share/doc/mousepad/copyright')
    if not license_path.is_file():raise SystemExit('Mousepad package license evidence is missing')
    sources={'capture.py':sha(Path(__file__).with_name('capture.py')),'derive.py':sha(Path(__file__)),'prepare_inputs.py':sha(Path(__file__).with_name('prepare_inputs.py')),'paint-provider.c':sha(Path(__file__).with_name('paint-provider.c'))}
    provenance={'schemaVersion':'mousepad-source-ledger-v1','stratum':'controlled-real-application','sourceGroup':plan['sourceGroup'],'application':plan['application'],'captureProfile':plan['captureProfile'],'controlledStyle':'GTK CSS provider, opaque green fill and magenta square border','sourceCodeSha256':sources,'appLicenseEvidence':{'path':str(license_path),'sha256':sha(license_path)},'inputManifestSha256':sha(root/'inputs.json'),'sourceTruthSha256':sha(path),'freshTruthSha256':sha(fresh_path),'cases':ledger}
    ledger_path=root/'source-ledger.json'
    with ledger_path.open('x') as f:json.dump(provenance,f,sort_keys=True,indent=2);f.write('\n')
    print(json.dumps({'cases':len(cases),'positive':counts['present'],'negative':counts['absent'],'uniqueImages':len({c['imageSha256'] for c in cases}),'inputSha256':sha(root/'inputs.json'),'truthSha256':sha(fresh_path),'sourceTruthSha256':sha(path),'ledgerSha256':sha(ledger_path)},sort_keys=True))


if __name__=='__main__': main(Path(sys.argv[1]))
