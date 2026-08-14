from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, random

DEST = "/home/user/italomoreirasp/assets/"
ONCA = (255, 196, 0)
INK = (11, 10, 8)

# ---------------------------------------------------------------- 1. retrato
# a origem tem 452x678: o upscale sozinho amolece. Máscara de nitidez devolve
# definição ao rosto sem criar halo visível.
src = Image.open(DEST + "originais/italo-oficial-bandeiras.jpeg").convert("RGB")
w, h = src.size
alt = int(w * 1.25)
y0 = max(0, min(28, h - alt))
foto = src.crop((0, y0, w, y0 + alt)).resize((1200, 1500), Image.LANCZOS)
foto = foto.filter(ImageFilter.UnsharpMask(radius=2.2, percent=115, threshold=3))
foto.save(DEST + "italo.jpg", quality=94)
print("italo.jpg -> 1200x1500 com máscara de nitidez")

# ------------------------------------------------------------ 2. onça-pintada
# rosetas em ladrilho perfeito: cada mancha é redesenhada nas quatro bordas
# para o padrão emendar sem costura visível.
T = 260
tile = Image.new("RGBA", (T, T), (0, 0, 0, 0))
td = ImageDraw.Draw(tile)
rnd = random.Random(11)

def roseta(cx, cy, r, rot):
    for dx in (-T, 0, T):
        for dy in (-T, 0, T):
            x, y = cx + dx, cy + dy
            if x < -r * 3 or x > T + r * 3 or y < -r * 3 or y > T + r * 3:
                continue
            # anel quebrado de manchas menores
            n = 6
            for k in range(n):
                a = rot + k * (2 * math.pi / n) + rnd.uniform(-.16, .16)
                px = x + math.cos(a) * r
                py = y + math.sin(a) * r * .86
                rr = r * rnd.uniform(.26, .40)
                td.ellipse([px - rr, py - rr * .82, px + rr, py + rr * .82],
                           fill=(0, 0, 0, 168))
            # miolo
            mr = r * .34
            td.ellipse([x - mr, y - mr * .8, x + mr, y + mr * .8],
                       fill=(0, 0, 0, 96))

pontos = [(46, 52, 26), (168, 40, 21), (104, 148, 28),
          (222, 152, 23), (28, 208, 20), (150, 236, 24), (236, 244, 18)]
for cx, cy, r in pontos:
    roseta(cx, cy, r, rnd.uniform(0, 6.28))

tile = tile.filter(ImageFilter.GaussianBlur(.6))
tile.save(DEST + "onca-tile.png")
print("onca-tile.png -> 260x260 sem emenda")

# ------------------------------------------------------------------ 3. ícone
for tam, nome in [(180, "icone-180.png"), (32, "favicon-32.png")]:
    ic = Image.new("RGB", (tam, tam), INK)
    di = ImageDraw.Draw(ic)
    # roseta de fundo, marca do partido
    r = tam * .30
    cx = cy = tam * .5
    for k in range(6):
        a = k * (2 * math.pi / 6) - .5
        px, py = cx + math.cos(a) * r, cy + math.sin(a) * r * .9
        rr = r * .30
        di.ellipse([px - rr, py - rr, px + rr, py + rr], fill=(58, 44, 6))
    f = ImageFont.truetype(
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        int(tam * .52))
    txt = "IM"
    tw = di.textlength(txt, font=f)
    asc, desc = f.getmetrics()
    di.text((cx - tw / 2, cy - (asc - desc) / 2 - tam * .04), txt, font=f, fill=ONCA)
    # faixa tricolor no rodapé do ícone
    fx = max(2, tam // 16)
    for i, cor in enumerate([(0, 175, 65), ONCA, (90, 130, 235)]):
        di.rectangle([i * tam / 3, tam - fx, (i + 1) * tam / 3, tam], fill=cor)
    ic.save(DEST + nome)
    print(nome, "gerado")
