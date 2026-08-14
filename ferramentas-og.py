from PIL import Image, ImageDraw, ImageFont
import numpy as np

W, H = 1200, 630
INK   = (11, 10, 8)
ONCA  = (255, 196, 0)
PAPER = (251, 248, 240)
STONE = (145, 138, 121)

F  = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FM = "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf"

# --- fundo: brilho radial suave, calculado por pixel (sem anéis) ---
yy, xx = np.mgrid[0:H, 0:W].astype(float)
dist = np.sqrt(((xx - 980) / 620) ** 2 + ((yy - 150) / 520) ** 2)
halo = np.clip(1 - dist, 0, 1) ** 2.2
base = np.zeros((H, W, 3))
for c in range(3):
    base[:, :, c] = INK[c] + (ONCA[c] - INK[c]) * halo * 0.30
img = Image.fromarray(base.astype("uint8"), "RGB")
d = ImageDraw.Draw(img, "RGBA")

# trama de meio-tom, a mesma da moldura do site
for y in range(0, H, 26):
    for x in range(0, W, 26):
        d.ellipse([x, y, x + 3, y + 3], fill=(255, 196, 0, 20))

def fit(txt, alvo, caminho=F, teto=220):
    s = teto
    while s > 8:
        f = ImageFont.truetype(caminho, s)
        if d.textlength(txt, font=f) <= alvo:
            return f
        s -= 2
    return ImageFont.truetype(caminho, 8)

M = 70
UTIL = W - M * 2

# --- retrato oficial a direita, fundindo no fundo pela borda esquerda ---
foto = Image.open("/home/user/italomoreirasp/assets/italo.jpg").convert("RGB")
fw = 400
fh = int(fw * 1.25)
foto = foto.resize((fw, fh), Image.LANCZOS)
mask = Image.new("L", (fw, fh), 255)
mpx = mask.load()
for y in range(fh):
    for x in range(fw):
        a = 255
        if x < 150: a = int(255 * (x / 150) ** 1.6)          # funde a esquerda
        if y < 90: a = min(a, int(255 * (y / 90) ** 1.4))    # funde o topo
        if y > fh - 130: a = min(a, int(255 * ((fh - y) / 130)))  # funde embaixo
        mpx[x, y] = a
img.paste(foto, (W - fw + 30, H - fh + 55), mask)
d = ImageDraw.Draw(img, "RGBA")

# --- sobrancelha ---
f_eb = ImageFont.truetype(FM, 22)
d.text((M, 64), "DEPUTADO ESTADUAL", font=f_eb, fill=ONCA)
lg = d.textlength("DEPUTADO ESTADUAL", font=f_eb)
d.text((M + lg + 18, 64), "· SÃO PAULO · 2026", font=f_eb, fill=STONE)
d.rectangle([M, 106, M + 62, 110], fill=ONCA)

# --- nome, ocupando a largura util ---
f1 = fit("ÍTALO MOREIRA", 730, teto=160)
asc, desc = f1.getmetrics()
d.text((M, 140), "ÍTALO MOREIRA", font=f1, fill=PAPER)

# --- tarja amarela inclinada ---
frase = "É A ESCOLHA CERTA"
f3 = fit(frase, 620, teto=84)
tw = int(d.textlength(frase, font=f3))
banda = Image.new("RGBA", (tw + 64, 108), (0, 0, 0, 0))
bd = ImageDraw.Draw(banda)
bd.rectangle([0, 0, banda.width, banda.height], fill=ONCA + (255,))
bd.text((32, 18), frase, font=f3, fill=INK)
banda = banda.rotate(2.2, expand=True, resample=Image.BICUBIC)
img.paste(banda, (M - 18, 300), banda)

# --- numeros do mandato ---
f_n = ImageFont.truetype(F, 46)
f_l = ImageFont.truetype(FM, 16)
base_y = 470
for i, (num, rot) in enumerate([("7.000+", "PROPOSITURAS"),
                                ("100+", "DENÚNCIAS AO MP"),
                                ("77,8 mil", "SEGUIDORES")]):
    x = M + i * 268
    d.text((x, base_y), num, font=f_n, fill=ONCA)
    d.text((x, base_y + 54), rot, font=f_l, fill=STONE)
    if i:
        d.rectangle([x - 32, base_y + 6, x - 31, base_y + 70], fill=(255, 196, 0, 55))

# --- faixa do Missao: preto, branco e amarelo ---
faixa = 16
for i, cor in enumerate([(17, 17, 17), PAPER, ONCA]):
    d.rectangle([0, H - faixa + i * (faixa // 3) - 1, W, H - faixa + (i + 1) * (faixa // 3)], fill=cor)

img.save("/home/user/italomoreirasp/assets/og.jpg", quality=94)
print("og.jpg 1200x630 gerado")
