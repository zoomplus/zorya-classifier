import sys
import unittest
import importlib.util
from pathlib import Path
import tempfile
import json

HERE=Path(__file__).parent
def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
mousepad=load_module('mousepad_derive',HERE/'mousepad'/'derive.py')
minetest=load_module('minetest_derive',HERE/'minetest'/'derive.py')
painted_body=mousepad.painted_body
validate_delta=minetest.validate_delta
validate_events=minetest.validate_events
source_alpha_support=minetest.source_alpha_support
prepare_ui=load_module('prepare_ui_inputs',HERE/'mousepad'/'prepare_inputs.py')


def rgba_image(w,h,color=(0,0,0,255)):
    return bytearray(color*(w*h))


class MousepadPaintTests(unittest.TestCase):
    def setUp(self):
        self.raw=rgba_image(20,20)
        for y in range(5,15):
            for x in range(4,16):
                i=(y*20+x)*4
                c=(255,0,255,255) if x in (4,15) or y in (5,14) else (0,208,32,255)
                self.raw[i:i+4]=bytes(c)

    def test_all_four_edges_and_fill_are_required(self):
        self.assertEqual(painted_body(bytes(self.raw),20,20,(4,5,12,10))['paintedPixelBounds'],[4,5,15,14])
        missing=bytearray(self.raw);i=(5*20+9)*4;missing[i:i+4]=bytes((0,208,32,255))
        with self.assertRaisesRegex(ValueError,'all four'):
            painted_body(bytes(missing),20,20,(4,5,12,10))

    def test_input_builder_uses_authored_tasks_without_truth_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);actions=['New','Open...','Save','Save As...','Reload','Close Tab','Undo','Redo','Cut','Copy','Paste','Find','Find and Replace...','Go to...','Fullscreen','Print','Spell Check','Toggle Line Numbers','Zoom In','Zoom Out']
            cases=[]
            for i,action in enumerate(actions,1):
                cid=f'mousepad-ui-v3-{i:02d}';present=action in prepare_ui.BUTTONS
                case=root/cid;case.mkdir();(case/'frame.png').write_bytes(bytes([i]))
                cases.append({'caseId':cid,'action':action,'expectedPresence':'present' if present else 'absent','task':f'the visible body of the {action} action button in the Mousepad toolbar, including its full painted background and border'})
            (root/'caseplan.json').write_text(json.dumps({'cases':cases}))
            rows=prepare_ui.build_inputs(root)
            self.assertEqual(len(rows),20)
            self.assertNotIn('expectedPresence',rows[0])
            self.assertNotIn('action',rows[0])
            source=[{'caseId':'x','expectedPresence':'present','region':{'left':128,'top':80,'width':256,'height':160}},
                    {'caseId':'y','expectedPresence':'absent'}]
            truth=mousepad.canonical_truth(source)
            self.assertEqual(truth[0]['targetBoxes'][0]['xyxy'],[0.1,0.1,0.3,0.3])
            self.assertEqual(truth[1]['targetBoxes'],[])
            self.assertTrue(truth[1]['negativeEvidence'])


class MinetestOracleTests(unittest.TestCase):
    def test_event_sequence_and_duplicate_events(self):
        def row(event,n): return {'event':event,'observed_target_entity_count':str(n),'observed_target_minimap_count':str(n),'observed_minimap_object_count':str(n),'observed_inventory':'oracle:map_marker@p' if n else ''}
        validate_events([row('join',0),row('on',1),row('off',0)],True)
        validate_events([row('join',0)],False)
        with self.assertRaisesRegex(ValueError,'event sequence'):
            validate_events([row('join',0),row('on',1),row('on',1),row('off',0)],True)

    def test_minimap_truth_is_canonical_normalized_fresh_truth(self):
        rows=[{'caseId':'map-1','expectedPresence':'present','region':{'left':15,'top':30,'width':6,'height':6}},
              {'caseId':'map-2','expectedPresence':'absent','negativeEvidence':'zero scoped inventory'}]
        truth=minetest.canonical_truth(rows)
        self.assertEqual(truth[0]['targetBoxes'][0]['xyxy'],[0.1,0.2,0.14,0.24])
        self.assertEqual(truth[1]['targetBoxes'],[])
        self.assertEqual(truth[1]['negativeEvidence'],'zero scoped inventory')

    def test_renderer_delta_must_be_bounded_and_sprite_sized(self):
        hidden=bytes(rgba_image(150,150))
        shown=bytearray(hidden)
        for y in range(40,46):
            for x in range(70,76):
                if (x+y)%5:
                    i=(y*150+x)*4;shown[i:i+4]=bytes((255,0,0,255))
        asset=bytes((255,255,255,255)*(16*16))
        self.assertEqual(validate_delta(hidden,bytes(shown),asset)[0],{'left':70,'top':40,'width':6,'height':6})
        noisy=bytearray(shown);i=(49*150+80)*4;noisy[i:i+4]=bytes((255,0,0,255))
        with self.assertRaisesRegex(ValueError,'6x6'):
            validate_delta(hidden,bytes(noisy),asset)
        edge=bytearray(shown)
        for x in range(70,76):
            i=(40*150+x)*4;edge[i:i+4]=bytes(hidden[i:i+4])
        with self.assertRaisesRegex(ValueError,'6x6'):
            validate_delta(hidden,bytes(edge),asset)

    def test_noise_at_transparent_source_corner_is_rejected(self):
        hidden=bytes(rgba_image(150,150));asset=bytearray((255,255,255,255)*(16*16));asset[3]=0
        support=source_alpha_support(bytes(asset),16,16,6,6)
        self.assertNotIn((0,0),support)
        shown=bytearray(hidden);left,top=70,40
        for x,y in support:
            i=((top+y)*150+left+x)*4;shown[i:i+4]=bytes((255,0,0,255))
        validate_delta(hidden,bytes(shown),bytes(asset))
        i=(top*150+left)*4;shown[i:i+4]=bytes((255,0,0,255))
        with self.assertRaisesRegex(ValueError,'alpha support'):
            validate_delta(hidden,bytes(shown),bytes(asset))


if __name__=='__main__': unittest.main()
