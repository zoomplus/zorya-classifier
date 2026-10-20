"""Create model-safe FreshCase inputs from Mousepad source-authored case tasks."""
import hashlib
import json
import re
import sys
from pathlib import Path

BUTTONS=['New','Open...','Save','Save As...','Reload','Close Tab','Undo','Redo','Cut','Copy','Paste','Find','Find and Replace...','Go to...','Fullscreen']
ABSENT=['Print','Spell Check','Toggle Line Numbers','Zoom In','Zoom Out']


def build_inputs(root: Path) -> list[dict]:
    root=root.resolve();plan=json.loads((root/'caseplan.json').read_text());specs=plan.get('cases',[])
    ids=[x.get('caseId') for x in specs]
    if len(specs)!=20 or len(set(ids))!=20 or any(not re.fullmatch(r'mousepad-ui-v3-[0-9]{2}',x or '') for x in ids):
        raise ValueError('unexpected or duplicate source case IDs')
    inputs=[]
    for spec in specs:
        cid=spec['caseId'];action=spec.get('action');presence=spec.get('expectedPresence');task=spec.get('task')
        if action not in BUTTONS+ABSENT or presence not in ('present','absent') or (action in BUTTONS)!=(presence=='present'):
            raise ValueError(f'invalid source-authored action descriptor: {cid}')
        expected=f'the visible body of the {action} action button in the Mousepad toolbar, including its full painted background and border'
        if task!=expected: raise ValueError(f'authored task text mismatch: {cid}')
        image=root/cid/'frame.png'
        if not image.is_file(): raise ValueError(f'missing captured source image: {cid}')
        inputs.append({'caseId':cid,'image':{'path':f'{cid}/frame.png','sha256':hashlib.sha256(image.read_bytes()).hexdigest(),'width':1280,'height':800},'locate':{'target':task},'classify':{'options':['present','absent']}})
    return inputs


def main(root: Path) -> None:
    rows=build_inputs(root);out=root.resolve()/'inputs.json'
    with out.open('x') as f:json.dump(rows,f,sort_keys=True,indent=2);f.write('\n')
    print(json.dumps({'cases':len(rows),'inputsSha256':hashlib.sha256(out.read_bytes()).hexdigest()},sort_keys=True))


if __name__=='__main__':main(Path(sys.argv[1]))
