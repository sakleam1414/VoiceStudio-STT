"""Test native widgets while the root is withdrawn; no desktop input or capture."""
import importlib.util
import io
import json
import logging
from pathlib import Path
import shutil
import tempfile
import tkinter as tk
from unittest.mock import patch

with tempfile.TemporaryDirectory(prefix='stt-widgets-') as temp:
    source=Path(temp)/'stt_server.py'
    project=Path(__file__).resolve().parent.parent
    shutil.copy(project/'stt_server.py',source)
    shutil.copytree(project/'assets',Path(temp)/'assets')
    spec=importlib.util.spec_from_file_location('stt_window_test',source)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original_tk=tk.Tk
    results=[]
    errors=[]
    payload={'services':{'stt':{'state':'active','text':'Запущен'},'startup':{'state':'inactive','text':'Выключена'},'tailscale':{'state':'unknown','text':'Не подключён'},'subtitles':{'state':'unknown','text':'Ожидание плагина'}},'message':''}
    def make_root():
        root=original_tk()
        root.withdraw()
        root.report_callback_exception=lambda *args: errors.append(args)
        def inspect():
            try:
                root.update_idletasks()
                def walk(parent):
                    for child in parent.winfo_children():
                        yield child
                        yield from walk(child)
                widgets=list(walk(root))
                canvases=[w for w in widgets if isinstance(w,tk.Canvas)]
                assert len(canvases)==3
                text=[canvas.itemcget(item,'text') for canvas in canvases for item in canvas.find_all() if canvas.type(item)=='text']
                assert any('Запущен' in value and 'выкл.' in value for value in text),text
                assert all(len(canvas.find_all())==3 for canvas in canvases)
                assert root.title()=='Voice Studio · Речь и субтитры'
                assert hasattr(root, 'brand_image')
                buttons=[w.cget('text') for w in widgets if isinstance(w,tk.Button)]
                assert sorted(buttons)==sorted(['Установить','Обновить ↻']),buttons
                assert root.winfo_reqwidth()<=820,root.winfo_reqwidth()
                assert root.winfo_reqheight()<=214,root.winfo_reqheight()
                assert not root.winfo_viewable()
                results.append((root.winfo_reqwidth(),root.winfo_reqheight()))
            except Exception as error:
                errors.append(error)
            finally:
                root.tk.call(root.protocol('WM_DELETE_WINDOW'))
        root.after(1000,inspect)
        return root
    with patch.object(tk,'Tk',make_root),patch.object(module.urllib.request,'urlopen',lambda *args,**kwargs:io.BytesIO(json.dumps(payload).encode())):
        module.run_dashboard()
    logging.shutdown()
    assert not errors,errors
    assert results
    print('PASS: withdrawn native window, three badges, status update, branded icon/title, no startup toggle, compact size, clean close.',results)
