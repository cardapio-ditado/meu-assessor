# Fotos da campanha

| Item | Situação |
|---|---|
| `italo.jpg` | ✅ No ar (topo + avatar de reserva). **Ver ressalva abaixo.** |
| `renan.jpg` | ✅ No ar. Recortada do original da Marcha da CNM, sem o logo da confederação nem a tarja do rodapé. |
| `insta/avatar.jpg` | ✅ No ar. Recortado do print do perfil. |
| `insta/post-01.jpg` … `post-09.jpg` | ✅ No ar. Os 9 primeiros posts reais do feed. |
| `insta/destaque-vaquinha.jpg` | ✅ No ar. Destaque "Vaquinha!". |
| `og.jpg` | ✅ Imagem de compartilhamento (WhatsApp e redes). Gerada por `ferramentas-og.py`. |

## Ressalva sobre a foto do topo

A foto usada como `italo.jpg` foi comparada com a foto oficial de urna legendada
"ÍTALO MOREIRA" no post do próprio perfil e com o avatar do Instagram, e as
feições não batem (linha do cabelo, formato do rosto). Ela está publicada por
decisão do cliente, mas **confirme com o Ítalo antes da apresentação**. O
original está em `originais/FOTO-NAO-E-O-ITALO-conferir.jpg`.

Para trocar: substitua `assets/italo.jpg` mantendo o nome. Ideal vertical 4:5
(1200×1500 px ou maior), rosto no terço superior. Fundo de qualquer cor — a
página aplica o tratamento. Marca d'água no rodapé some sozinha.

Ajuste fino de corte: mude `--pos` na moldura correspondente do `index.html`.

```html
<div class="photo-frame" style="--pos:50% 18%">
```

## Cores

- **Missão:** preto `#0B0A08`, branco `#FBF8F0`, amarelo `#FFC400` — a base.
- **Bandeira:** verde `#009B3A` e azul `#1B3C8F` entram só como detalhe
  (traço tricolor, números do mandato, ícones, costura entre seções).
- Seções claras usam `#F6F3EA`; basta a classe `claro` na `<section>`.

`originais/` guarda tudo como foi enviado e **não vai ao ar** (`.vercelignore`).
