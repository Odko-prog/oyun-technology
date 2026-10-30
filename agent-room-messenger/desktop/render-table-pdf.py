"""Local desktop PDF renderer. Not a cloud-worker capability or Office converter."""
import argparse, hashlib, json, os, pathlib, tempfile
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, TableStyle

def inspect_layout(path):
    # Read the actual temporary PDF before exposing a final artifact path.
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        if not 1<=len(pdf.pages)<=100: raise ValueError('PDF page count limit')
        count=0
        for page in pdf.pages:
            for c in page.chars:
                count+=1
                if count>200000 or not (35<=c['x0']<=c['x1']<=page.width-35 and 25<=c['top']<=c['bottom']<=page.height-14):
                    raise ValueError('Text outside validated page bounds')
        if count==0: raise ValueError('PDF has no readable text')
        return dict(pages=len(pdf.pages),characters=count,boundsPassed=True,visualVerified=False)

def render(spec, output, font_path):
    headers=spec.get('headers'); rows=spec.get('rows'); title=spec.get('title')
    if not isinstance(title,str) or not title.strip() or len(title)>240:
        raise ValueError('Invalid title')
    if not isinstance(headers,list) or not 1<=len(headers)<=6 or not isinstance(rows,list) or not 1<=len(rows)<=1000:
        raise ValueError('Table dimensions outside limits')
    paragraphs=spec.get('paragraphs',[])
    if not isinstance(paragraphs,list) or len(paragraphs)>20:
        raise ValueError('Paragraph limit')
    texts=[title]+headers+paragraphs
    for row in rows:
        if not isinstance(row,list) or len(row)!=len(headers): raise ValueError('Inconsistent row width')
        texts+=row
    if any(not isinstance(t,str) or len(t)>4000 for t in texts) or sum(map(len,texts))>120000:
        raise ValueError('Text limits exceeded')
    output=pathlib.Path(output)
    if output.exists(): raise FileExistsError('Output already exists')
    if not output.parent.is_dir(): raise ValueError('Output directory must exist')
    pdfmetrics.registerFont(TTFont('DocumentUnicode',str(font_path)))
    # Fail before writing if a glyph is absent. No silent transliteration/substitution.
    glyphs=pdfmetrics.getFont('DocumentUnicode').face.charToGlyph
    if any(ord(c) not in glyphs for t in texts for c in t if not c.isspace()):
        raise ValueError('Font does not contain all requested characters')
    body=ParagraphStyle('Body',fontName='DocumentUnicode',fontSize=9,leading=13,spaceAfter=8)
    cell=ParagraphStyle('Cell',parent=body,fontSize=8.5,leading=12,spaceAfter=0,alignment=TA_LEFT,splitLongWords=True)
    heading=ParagraphStyle('Title',parent=body,fontSize=17,leading=23,textColor=colors.HexColor('#15364D'),spaceAfter=12)
    header=ParagraphStyle('Header',parent=cell,textColor=colors.white)
    para=lambda t,style: Paragraph(escape(t).replace('\n','<br/>'),style)
    story=[para(title,heading)]+[para(t,body) for t in paragraphs]+[Spacer(1,6)]
    weights=spec.get('columnWeights',[1]*len(headers))
    if not isinstance(weights,list) or len(weights)!=len(headers) or any(type(w) not in (int,float) or not 0.1<=w<=10 for w in weights):
        raise ValueError('Invalid column weights')
    widths=[(A4[0]-88)*w/sum(weights) for w in weights]
    table=LongTable([[para(t,header) for t in headers]]+[[para(t,cell) for t in row] for row in rows],
                    colWidths=widths,repeatRows=1,splitByRow=1,splitInRow=0,hAlign='LEFT')
    table.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#234D66')),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F2F6F8')]),
        ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),
        ('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),
        ('BOTTOMPADDING',(0,0),(-1,-1),7),
        ('LINEBELOW',(0,0),(-1,0),0.5,colors.HexColor('#234D66')),
        ('LINEBELOW',(0,1),(-1,-1),0.25,colors.HexColor('#D6E0E6'))]))
    story.append(table)
    def page(canvas,doc):
        canvas.saveState();canvas.setFont('DocumentUnicode',8);canvas.setFillColor(colors.HexColor('#536776'))
        canvas.drawRightString(A4[0]-44,25,str(doc.page));canvas.restoreState()
    fd,temporary=tempfile.mkstemp(prefix='.pdf-render-',suffix='.pdf',dir=output.parent);os.close(fd)
    try:
        SimpleDocTemplate(temporary,pagesize=A4,rightMargin=44,leftMargin=44,topMargin=40,bottomMargin=42,
                          title=title,author='').build(story,onFirstPage=page,onLaterPages=page)
        layout=inspect_layout(temporary)
        data=pathlib.Path(temporary).read_bytes()
        # Same-filesystem exclusive link publishes only a completely written, checked file.
        # Existing outputs are never replaced; the temporary link is removed in finally.
        os.link(temporary,output)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)
    return dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),rows=len(rows),columns=len(headers),layout=layout,
                scope='local desktop generation only; render and content QA required before delivery')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('output');p.add_argument('--font',required=True);a=p.parse_args()
    source=pathlib.Path(a.input)
    if source.stat().st_size>2000000: raise ValueError('Input byte limit')
    print(json.dumps(render(json.loads(source.read_text(encoding='utf-8-sig')),a.output,a.font)))
