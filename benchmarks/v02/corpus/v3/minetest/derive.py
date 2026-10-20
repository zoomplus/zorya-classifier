"""Derive private FreshCase/FreshTruth files from controlled Minetest differential captures."""
from __future__ import annotations
import hashlib, json, struct, subprocess, sys
from pathlib import Path
import re

ASSET_SHA256='17386c72db28b5ed7c99a60fcbfa5b3fa7286cab7c1228d895bb54f0a5985ad5'
RENDERER_SHA256='ded29762ae3c723dd923a89a01c5b8a197bb30443a0155bf0cc22b3bff13f855'


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgba(path: Path) -> bytes:
    return subprocess.run(
        ['ffmpeg','-hide_banner','-loglevel','error','-i',str(path),'-f','rawvideo','-pix_fmt','rgba','-'],
        check=True,capture_output=True
    ).stdout


def png_size(path: Path) -> tuple[int,int]:
    b=path.read_bytes()
    if b[:8] != b'\x89PNG\r\n\x1a\n' or len(b)<24: raise ValueError(f'not a PNG: {path}')
    return struct.unpack('>II',b[16:24])


def parse_events(text: str) -> list[dict[str,str]]:
    rows=[]
    for line in text.splitlines():
        marker='ORACLE_CAPTURE_STATE '
        if marker not in line: continue
        row={}
        for part in line.split(marker,1)[1].split():
            if '=' in part:
                k,v=part.split('=',1);row[k]=v
        rows.append(row)
    return rows


def validate_events(events: list[dict[str,str]], present: bool) -> None:
    expected=['join','on','off'] if present else ['join']
    names=[row.get('event') for row in events]
    if names != expected:
        raise ValueError(f'event sequence must be exactly {expected}, got {names}')
    by_event={row['event']:row for row in events}
    for row in events:
        for key in ('observed_target_entity_count','observed_target_minimap_count','observed_minimap_object_count'):
            if not row.get(key, '').isdigit(): raise ValueError(f'missing observed inventory field {key}')
    if by_event['join']['observed_target_entity_count']!='0' or by_event['join']['observed_target_minimap_count']!='0':
        raise ValueError('target entity must be absent in initial observed inventory')
    if by_event['join']['observed_minimap_object_count']!='0': raise ValueError('initial minimap inventory is not empty')
    if present:
        on=by_event['on'];off=by_event['off']
        if (on['observed_target_entity_count'],on['observed_target_minimap_count'],on['observed_minimap_object_count']) != ('1','1','1'):
            raise ValueError('present state must enumerate exactly one target and one minimap object')
        if 'oracle:map_marker@' not in on.get('observed_inventory',''):
            raise ValueError('present target is missing from the observed minimap inventory')
        if (off['observed_target_entity_count'],off['observed_target_minimap_count'],off['observed_minimap_object_count']) != ('0','0','0'):
            raise ValueError('target remains in observed inventory after removal')


def source_alpha_support(asset: bytes, source_width: int, source_height: int, draw_width: int, draw_height: int) -> set[tuple[int,int]]:
    """Map source texels to destination pixels using the pinned draw2DImage nearest sample."""
    support=set()
    for y in range(draw_height):
        sy=(y*source_height)//draw_height
        for x in range(draw_width):
            sx=(x*source_width)//draw_width
            if asset[(sy*source_width+sx)*4+3]>0: support.add((x,y))
    return support


def validate_delta(hidden: bytes, shown: bytes, asset: bytes) -> tuple[dict,int]:
    if len(hidden)!=150*150*4 or len(shown)!=150*150*4: raise ValueError('invalid minimap crop dimensions')
    if len(asset)!=16*16*4: raise ValueError('unexpected official marker asset dimensions')
    alpha=[(i//4%16,i//4//16) for i in range(3,len(asset),4) if asset[i]>0]
    alpha_box=(min(x for x,y in alpha),min(y for x,y in alpha),max(x for x,y in alpha),max(y for x,y in alpha))
    if alpha_box!=(0,0,15,15): raise ValueError('official marker alpha support changed')
    changed=[]
    for i in range(0,len(shown),4):
        if hidden[i:i+4]!=shown[i:i+4]: changed.append(i//4)
    if not changed: raise ValueError('no rendered marker change')
    xs=[p%150 for p in changed];ys=[p//150 for p in changed]
    left,top,right,bottom=min(xs),min(ys),max(xs),max(ys)
    # Minetest 5.6.1 draws object markers at 2*floor(.025*viewportWidth).
    # The frozen minimap viewport/crop is 150 pixels wide, hence a 6px full sprite box.
    if (right-left+1,bottom-top+1)!=(6,6): raise ValueError('renderer delta does not match the source-derived 6x6 sprite draw bounds')
    if not any(x==left for x in xs) or not any(x==right for x in xs) or not any(y==top for y in ys) or not any(y==bottom for y in ys):
        raise ValueError('visible sprite support does not reach all four source-derived box edges')
    support=source_alpha_support(asset,16,16,6,6)
    if any((p%150-left,p//150-top) not in support for p in changed):
        raise ValueError('pixel delta includes texels outside the pinned nearest-sampled source alpha support')
    region={'left':left,'top':top,'width':6,'height':6}
    return region,len(changed)


def canonical_truth(rows: list[dict]) -> list[dict]:
    result=[]
    for row in rows:
        boxes=[]
        if row['expectedPresence']=='present':
            r=row['region'];boxes=[{'xyxy':[r['left']/150,r['top']/150,(r['left']+r['width'])/150,(r['top']+r['height'])/150]}]
        result.append({'caseId':row['caseId'],'expectedPresence':row['expectedPresence'],'targetBoxes':boxes,
            'negativeEvidence':None if boxes else row['negativeEvidence']})
    return result


def main(root: Path) -> None:
    root=root.resolve();plan=json.loads((root/'caseplan.json').read_text())
    inputs=[];truth=[];ledger=[];all_ids=set();hashes=set()
    if len(plan.get('cases',[]))!=20: raise ValueError('map corpus must contain exactly 20 cases')
    if len({c.get('caseId') for c in plan['cases']})!=20: raise ValueError('duplicate case id')
    if any(not re.fullmatch(r'map-oracle-v3-[0-9]{2}',c.get('caseId','')) for c in plan['cases']): raise ValueError('unsafe or unexpected case id')
    counts={'present':0,'absent':0}
    asset_path=root.parents[1]/'root/usr/share/games/minetest/textures/base/pack/object_marker_red.png'
    renderer_path=root.parents[1]/'minimap-5.6.1.cpp'
    if not renderer_path.is_file(): raise ValueError('pinned Minetest renderer source is missing')
    if sha(renderer_path)!=RENDERER_SHA256: raise ValueError('pinned Minetest 5.6.1 renderer source hash mismatch')
    if sha(asset_path)!=ASSET_SHA256: raise ValueError('official Minetest marker asset hash mismatch')
    asset=rgba(asset_path)
    for c in plan['cases']:
        cid=c['caseId'];d=root/cid
        if (d/'cleanup-errors.txt').exists(): raise ValueError(f'owned process cleanup failed: {cid}')
        if cid in all_ids: raise ValueError('duplicate case id')
        all_ids.add(cid)
        transform=json.loads((d/'crop-transform.json').read_text())
        crop=transform['crop']; window=transform['window']
        if (crop['width'],crop['height'])!=(150,150) or crop['left']!=window['X']+864 or crop['top']!=window['Y']+29:
            raise ValueError(f'crop transform mismatch: {cid}')
        for name in ('hidden-a','hidden-b','shown'):
            frame=d/f'frame-{name}.png';img=d/f'crop-{name}.png'
            if not frame.exists() or not img.exists():
                if name=='shown' and c['expectedPresence']=='absent': continue
                raise ValueError(f'missing capture: {cid}/{name}')
            if png_size(img)!=(150,150): raise ValueError(f'crop dimensions mismatch: {cid}/{name}')
            expected=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(frame),'-vf',f"crop=150:150:{crop['left']}:{crop['top']}",'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','-'],check=True,capture_output=True).stdout
            if expected != rgba(img): raise ValueError(f'saved input is not the recorded screenshot crop: {cid}/{name}')
        hidden_a=rgba(d/'crop-hidden-a.png');hidden_b=rgba(d/'crop-hidden-b.png')
        if len(hidden_a)!=150*150*4 or hidden_a!=hidden_b: raise ValueError(f'hidden captures differ: {cid}')
        events=parse_events((d/'server.log').read_text(errors='replace'))
        is_present=c['expectedPresence']=='present'
        validate_events(events,is_present)
        by_event={row['event']:row for row in events}
        counts['present' if is_present else 'absent']+=1
        if is_present:
            shown=rgba(d/'crop-shown.png')
            region,changed_count=validate_delta(hidden_a,shown,asset)
            used=d/'crop-shown.png'
            truthrow={'caseId':cid,'expectedPresence':'present','imageSha256':sha(used),'region':region,'positiveEvidence':'observed absent/present/absent entity enumeration, exact hidden crop pixel equality, and source-derived full 6x6 renderer sprite support with no changed pixels outside it'}
        else:
            if set(by_event)!={'join'}: raise ValueError(f'unexpected entity event for negative: {cid}')
            used=d/'crop-hidden-a.png'
            truthrow={'caseId':cid,'expectedPresence':'absent','imageSha256':sha(used),'negativeEvidence':'bounded observed object enumeration at the fixed player location found zero minimap-rendered objects and zero target entities; hidden A/B minimap crops are identical'}
        digest=sha(used)
        if digest in hashes: raise ValueError('duplicate input image bytes')
        hashes.add(digest)
        inputs.append({'caseId':cid,'image':{'path':f'{cid}/{used.name}','sha256':digest,'width':150,'height':150},'locate':{'target':c['task']['target']},'classify':{'question':f'Does the image contain {c["task"]["target"]}?','options':['present','absent']}})
        truth.append(truthrow)
        ledger.append({'caseId':cid,'inputImageSha256':digest,'screenHiddenASha256':sha(d/'frame-hidden-a.png'),'screenHiddenBSha256':sha(d/'frame-hidden-b.png'),'screenShownSha256':sha(d/'frame-shown.png') if is_present else None,'cropTransform':transform,'captureLogSha256':sha(d/'server.log'),'worldmodSha256':sha(d/'world/worldmods/oracle/init.lua'),'captureSourceSha256':sha(Path(__file__).with_name('capture.py')),'oracleSourceSha256':sha(Path(__file__).with_name('oracle.lua')),'derivationSourceSha256':sha(Path(__file__)),'officialMarkerAssetSha256':sha(asset_path),'minetestRendererSourceSha256':sha(renderer_path)})
    if counts!={'present':15,'absent':5}: raise ValueError(f'unexpected class counts: {counts}')
    source_truth={'schemaVersion':'minetest-map-oracle-truth-v1','sourceGroup':plan['sourceGroup'],'cases':truth}
    fresh_truth=canonical_truth(truth)
    for name,obj in [('inputs.json',inputs),('source-truth.json',source_truth),('truth.json',fresh_truth)]:
        p=root/name
        with p.open('x') as f: json.dump(obj,f,sort_keys=True,indent=2);f.write('\n')
    license_path=root.parents[1]/'root/usr/share/doc/minetest-data/copyright'
    ledger_doc={'schemaVersion':'minetest-source-ledger-v1','stratum':'controlled-real-game-map','sourceGroup':plan['sourceGroup'],'application':'Minetest 5.6.1','game':'Minetest Game','inputManifestSha256':sha(root/'inputs.json'),'sourceTruthSha256':sha(root/'source-truth.json'),'freshTruthSha256':sha(root/'truth.json'),'officialMarkerAssetSha256':sha(asset_path),'minetestRendererSourceSha256':sha(renderer_path),'licenseEvidence':{'path':str(license_path),'sha256':sha(license_path),'markerAssetLicense':'CC-BY-SA-3.0'},'captureSourceSha256':sha(Path(__file__).with_name('capture.py')),'oracleSourceSha256':sha(Path(__file__).with_name('oracle.lua')),'derivationSourceSha256':sha(Path(__file__)),'cases':ledger}
    ledger_path=root/'source-ledger.json'
    with ledger_path.open('x') as f:json.dump(ledger_doc,f,sort_keys=True,indent=2);f.write('\n')
    print(json.dumps({'cases':len(inputs),'present':sum(x['expectedPresence']=='present' for x in truth),'absent':sum(x['expectedPresence']=='absent' for x in truth),'uniqueImageBytes':len(hashes),'inputSha256':sha(root/'inputs.json'),'truthSha256':sha(root/'truth.json'),'sourceTruthSha256':sha(root/'source-truth.json'),'ledgerSha256':sha(root/'source-ledger.json')},sort_keys=True))

if __name__=='__main__': main(Path(sys.argv[1]))
