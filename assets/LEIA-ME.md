# Fotos da campanha

## Estado atual

| Item | Situação |
|---|---|
| `renan.jpg` | ✅ No ar. Recortada do original da Marcha da CNM, sem o logo da confederação nem a tarja do rodapé. |
| `insta/avatar.jpg` | ✅ No ar. Recortado do print do perfil. |
| `insta/post-01.jpg` … `post-09.jpg` | ✅ No ar. Os 9 primeiros posts reais do feed. |
| `insta/destaque-vaquinha.jpg` | ✅ No ar. Destaque "Vaquinha!". |
| `italo.jpg` | ❌ **Falta.** A foto enviada como `iTALO.jpg` é de outra pessoa — ver abaixo. |

## Atenção: a foto do topo ainda não é do Ítalo

O arquivo enviado como `iTALO.jpg` (fundo laranja) foi comparado com a foto
oficial de urna legendada "ÍTALO MOREIRA" no post do próprio perfil e com o
avatar do Instagram: **é outra pessoa**. Ele está guardado em
`originais/FOTO-NAO-E-O-ITALO-conferir.jpg` e foi retirado da página.

Para completar, envie uma foto oficial do Ítalo e salve como `assets/italo.jpg`:

- vertical, proporção 4:5 (ideal 1200×1500 px ou maior);
- rosto no terço superior;
- fundo de qualquer cor — a página aplica o tratamento do Missão;
- marca d'água no rodapé some sozinha.

Enquanto o arquivo não existir, a moldura dourada de reserva aparece no lugar
e nada quebra.

## Trocar qualquer foto

Basta substituir o arquivo mantendo o nome. Para ajustar o corte, mude
`--pos` na moldura correspondente do `index.html`:

```html
<div class="photo-frame" style="--pos:50% 18%">
```

Menor o segundo número, mais alto o corte fica na foto.

`originais/` guarda tudo como foi enviado, incluindo o .zip do WhatsApp.
