"""Scene composition paired with web/src/scene.ts; text rasterization is shared exactly."""
import math
from functools import lru_cache
from PIL import Image, ImageDraw


@lru_cache(maxsize=4)
def vignette(w, h):
    overlay = Image.new('RGBA', (w, h))
    d = ImageDraw.Draw(overlay)
    for y in range(h):
        alpha = int(max(0, (y / h - .58) / .42) * 130)
        d.line((0, y, w, y), fill=(12, 15, 19, alpha))
    return overlay


def nine_slice(source, size):
    w, h = size
    sw, sh = source.size
    edge = max(1, round(min(sw, sh) * .12))
    dest_edge = min(38, round(min(w, h) * .2))
    out = Image.new('RGBA', size)
    xs, ys = [0, edge, sw-edge, sw], [0, edge, sh-edge, sh]
    dx, dy = [0, dest_edge, w-dest_edge, w], [0, dest_edge, h-dest_edge, h]
    for row in range(3):
        for col in range(3):
            tile = source.crop((xs[col], ys[row], xs[col+1], ys[row+1]))
            tile = tile.resize((dx[col+1]-dx[col], dy[row+1]-dy[row]), Image.Resampling.LANCZOS)
            out.alpha_composite(tile, (dx[col], dy[row]))
    return out


def paint_scene(renderer, t):
    doc, w, h = renderer.doc, renderer.w, renderer.h
    src = renderer.background
    scale = max(w / src.width, h / src.height) * (1 + .045 * doc.motionAmount if doc.cameraMotion else 1)
    sw, sh = round(src.width*scale), round(src.height*scale)
    phase = t * math.tau / 8
    ox = (sw-w)/2 + (math.sin(phase)*(sw-w)*.4 if doc.cameraMotion else 0)
    oy = (sh-h)/2 + (math.cos(phase)*(sh-h)*.4 if doc.cameraMotion else 0)
    frame = src.resize((sw, sh), Image.Resampling.NEAREST).crop((round(ox),round(oy),round(ox)+w,round(oy)+h))
    if doc.lightPulse:
        glow = Image.new('RGBA', (w,h), (234,184,101,round((5+4*math.sin(phase))*doc.motionAmount)))
        frame = Image.alpha_composite(frame, glow)
    particles = Image.new('RGBA', (w,h)); d = ImageDraw.Draw(particles)
    for i in range(round(20 + 50*doc.motionAmount)):
        mode = doc.atmosphere
        x = (i*137.19 + t*(28 if mode == 'rain' else 7)) % w
        y = (i*83.71 + t*(260 if mode == 'rain' else 24 if mode == 'snow' else -8)) % (h*.78)
        if mode == 'rain':
            d.line((x,y,x-6,y+18),fill=(169,188,213,90),width=2)
        elif mode in ('snow','dust','fireflies'):
            x += math.sin(phase+i)*12
            r = 2 if mode != 'dust' else 1
            alpha = round(90+70*math.sin(phase+i))
            d.ellipse((x-r,y-r,x+r,y+r), fill=(235,217,161,alpha) if mode != 'snow' else (226,233,242,140))
    frame = Image.alpha_composite(frame, particles)
    cue = next((c for c in doc.cues if c.start <= t < c.end), None)
    action = renderer.actions.get(cue.action) if cue and cue.action else renderer.default_action
    if action:
        elapsed = ((t-(cue.start if cue else 0))*1000) % sum(action['durations'])
        index = 0
        while index < len(action['durations'])-1 and elapsed >= action['durations'][index]:
            elapsed -= action['durations'][index]; index += 1
        sprite = renderer.images[action['frames'][index]]
    else:
        sprite = renderer.images.get(doc.character)
    if sprite:
        sh = round(h*doc.characterScale); sw = round(sh*sprite.width/sprite.height)
        frame.alpha_composite(sprite.resize((sw,sh),Image.Resampling.NEAREST),(round(w*doc.characterX-sw/2),round(h*doc.characterY-sh)))
    frame = Image.alpha_composite(frame, vignette(w,h))
    draw = ImageDraw.Draw(frame)
    x,y,bw,bh = round(w*.035),round(h*doc.dialogY),round(w*.93),round(h*doc.dialogHeight)
    if renderer.panel:
        frame.alpha_composite(nine_slice(renderer.panel,(bw,bh)),(x,y))
    else:
        draw.rectangle((x,y,x+bw,y+bh),fill=doc.panelColor,outline=doc.accentColor,width=2)
        inset = 8 if doc.skin in ('pixel','cream','night') else 12
        draw.rectangle((x+inset,y+inset,x+bw-inset,y+bh-inset),outline=doc.accentColor,width=2 if doc.skin == 'pixel' else 1)
        if doc.skin == 'ornate':
            for px,py in [(x,y),(x+bw,y),(x,y+bh),(x+bw,y+bh)]:
                draw.polygon([(px-5,py),(px,py-5),(px+5,py),(px,py+5)],fill=doc.accentColor)
    key = cue.id if cue else '__interlude'
    fraction = min(1,max(0,(t-cue.start)/max(.01,(cue.end-cue.start)*.85))) if cue else 1
    count = max(1,math.floor(len(renderer.typeset.layouts[key])*fraction))
    renderer.typeset.paint(frame,key,count,doc.reveal if cue else 'line')
    frame.alpha_composite(renderer.typeset.title,(round(w*.05),round(h*.028)))
    if fraction >= 1 and int(t*2)%2 == 0:
        draw = ImageDraw.Draw(frame)
        px,py=x+bw-25,y+bh-24
        draw.polygon([(px,py),(px,py+9),(px+7,py+4)],fill=doc.accentColor)
    return frame.convert('RGB')
