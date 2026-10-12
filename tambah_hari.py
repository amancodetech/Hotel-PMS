#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
أداة إضافة أيام جديدة تلقائياً لملفات PMS الفندقية:
- Laporan Harian Hotel.xlsx (فندق 51 وحدة)
- Laporan Harian Villa.xlsx (فلل 72 غرفة)
"""

import sys, os, zipfile, shutil
from datetime import datetime, timedelta
import xml.etree.ElementTree as ET

MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

ns_wb = {'s': MAIN_NS, 'r': OFFICE_REL_NS}
ns_rel = {'rel': REL_NS}

def add_days(target_file, days_to_add=1):
    if not os.path.exists(target_file):
        print(f"❌ الملف غير موجود: {target_file}")
        return False

    unpack_dir = '/tmp/pms_unpack_add_days'
    if os.path.exists(unpack_dir):
        shutil.rmtree(unpack_dir)

    with zipfile.ZipFile(target_file, 'r') as z:
        z.extractall(unpack_dir)

    wb_p = os.path.join(unpack_dir, 'xl/workbook.xml')
    wb_tree = ET.parse(wb_p)
    wb_root = wb_tree.getroot()
    sheets_el = wb_root.find('s:sheets', ns_wb)

    existing_sheets = []
    max_date = None
    max_sheet_id = 0

    for s in sheets_el.findall('s:sheet', ns_wb):
        s_name = s.attrib.get('name')
        s_id = int(s.attrib.get('sheetId', 0))
        if s_id > max_sheet_id:
            max_sheet_id = s_id
        existing_sheets.append(s_name)

        if len(s_name) == 10 and s_name[2] == '-' and s_name[5] == '-':
            try:
                d = datetime.strptime(s_name, '%d-%m-%Y')
                if max_date is None or d > max_date:
                    max_date = d
            except ValueError:
                pass

    if max_date is None:
        print(f"❌ لم يتم العثور على أي شيت يومي في {os.path.basename(target_file)}!")
        return False

    rels_p = os.path.join(unpack_dir, 'xl/_rels/workbook.xml.rels')
    rels_tree = ET.parse(rels_p)
    rels_root = rels_tree.getroot()

    r_ids = []
    for r in rels_root.findall('rel:Relationship', ns_rel):
        rid = r.attrib.get('Id', '')
        if rid.startswith('rId'):
            try:
                r_ids.append(int(rid[3:]))
            except ValueError:
                pass

    max_rid = max(r_ids) if r_ids else 50

    sheet_map = {r.attrib['Id']: r.attrib['Target'] for r in rels_root.findall('rel:Relationship', ns_rel)}
    tmpl_sheet_el = None
    tmpl_rid = None
    for s in sheets_el.findall('s:sheet', ns_wb):
        if s.attrib.get('name') == 'TEMPLATE':
            tmpl_sheet_el = s
            tmpl_rid = s.attrib.get(f'{{{OFFICE_REL_NS}}}id')
            break

    if not tmpl_rid or tmpl_rid not in sheet_map:
        print("❌ لم يتم العثور على شيت TEMPLATE المرجعي!")
        return False

    tmpl_xml_rel = sheet_map[tmpl_rid]
    tmpl_full_path = os.path.join(unpack_dir, 'xl', tmpl_xml_rel)

    import glob
    existing_sheet_files = glob.glob(os.path.join(unpack_dir, 'xl/worksheets/sheet*.xml'))
    highest_sheet_num = 0
    for f in existing_sheet_files:
        b = os.path.basename(f)
        num_str = b.replace('sheet', '').replace('.xml', '')
        if num_str.isdigit():
            highest_sheet_num = max(highest_sheet_num, int(num_str))

    with open(tmpl_full_path, 'r', encoding='utf-8') as f:
        tmpl_content = f.read()

    base_excel_date = datetime(1899, 12, 30)
    tmpl_index_in_children = list(sheets_el).index(tmpl_sheet_el)

    added_names = []
    current_date = max_date

    for i in range(days_to_add):
        current_date += timedelta(days=1)
        new_name = current_date.strftime('%d-%m-%Y')
        if new_name in existing_sheets:
            continue

        highest_sheet_num += 1
        max_rid += 1
        max_sheet_id += 1

        new_xml_rel = f"worksheets/sheet{highest_sheet_num}.xml"
        new_rid = f"rId{max_rid}"

        serial_val = (current_date - base_excel_date).days
        new_tree = ET.fromstring(tmpl_content)
        
        r2 = new_tree.find('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row[@r="2"]')
        if r2 is not None:
            c_b2 = r2.find('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c[@r="B2"]')
            if c_b2 is not None:
                v_el = c_b2.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                if v_el is None:
                    v_el = ET.SubElement(c_b2, '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                v_el.text = str(serial_val)

        new_sheet_full_path = os.path.join(unpack_dir, 'xl', new_xml_rel)
        ET.ElementTree(new_tree).write(new_sheet_full_path, xml_declaration=True, encoding='utf-8')

        tmpl_rels_p = os.path.join(unpack_dir, 'xl/worksheets/_rels', os.path.basename(tmpl_xml_rel) + '.rels')
        if os.path.exists(tmpl_rels_p):
            new_rels_p = os.path.join(unpack_dir, 'xl/worksheets/_rels', f"sheet{highest_sheet_num}.xml.rels")
            shutil.copy(tmpl_rels_p, new_rels_p)

        new_s_el = ET.Element('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet', {
            'name': new_name,
            'sheetId': str(max_sheet_id),
            f'{{{OFFICE_REL_NS}}}id': new_rid
        })
        sheets_el.insert(tmpl_index_in_children + len(added_names), new_s_el)

        ET.SubElement(rels_root, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship', {
            'Id': new_rid,
            'Type': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
            'Target': new_xml_rel
        })

        ct_p = os.path.join(unpack_dir, '[Content_Types].xml')
        ct_tree = ET.parse(ct_p)
        ct_root = ct_tree.getroot()
        ET.SubElement(ct_root, '{http://schemas.openxmlformats.org/package/2006/content-types}Override', {
            'PartName': f"/xl/{new_xml_rel}",
            'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
        })
        ct_tree.write(ct_p, xml_declaration=True, encoding='utf-8')

        added_names.append(new_name)

    if not added_names:
        print(f"ℹ️ لم يتم إضافة أيام جديدة لـ {os.path.basename(target_file)}.")
        return True

    wb_tree.write(wb_p, xml_declaration=True, encoding='utf-8')
    rels_tree.write(rels_p, xml_declaration=True, encoding='utf-8')

    temp_zip = '/tmp/repacked_new_days.xlsx'
    with zipfile.ZipFile(temp_zip, 'w', zipfile.ZIP_DEFLATED) as z_out:
        for root_d, dirs, files in os.walk(unpack_dir):
            for file in files:
                full_path = os.path.join(root_d, file)
                rel_path = os.path.relpath(full_path, unpack_dir)
                z_out.write(full_path, rel_path)

    shutil.copy(temp_zip, target_file)
    print(f"✅ تم بنجاح إضافة {len(added_names)} يوم لـ [{os.path.basename(target_file)}]:")
    print(f"   من: {added_names[0]}  إلى: {added_names[-1]}")
    return True

if __name__ == '__main__':
    target = 'hotel'
    days = 1
    
    args = sys.argv[1:]
    for a in args:
        if a.lower() in ['hotel', 'فندق']:
            target = 'hotel'
        elif a.lower() in ['villa', 'فلل', 'فيلا']:
            target = 'villa'
        elif a.isdigit():
            days = int(a)

    files_to_update = []
    if target in ['hotel', 'all']:
        files_to_update.append(('/home/omar/Desktop/Hotel/Laporan Harian Hotel.xlsx', '/home/omar/Downloads/Laporan Harian Hotel.xlsx'))
    if target in ['villa', 'all']:
        files_to_update.append(('/home/omar/Desktop/Hotel/Laporan Harian Villa.xlsx', '/home/omar/Downloads/Laporan Harian Villa.xlsx'))

    for local_f, dl_f in files_to_update:
        if os.path.exists(local_f):
            add_days(local_f, days)
            if os.path.exists(os.path.dirname(dl_f)):
                try:
                    shutil.copy(local_f, dl_f)
                    print(f"   تم نسخ التحديث لـ: {dl_f}")
                except Exception as e:
                    print(f"   ⚠️ تعذر نسخ التنزيلات: {e}")
