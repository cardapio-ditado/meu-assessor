# Fotos da campanha

> **Já estão no ar:** `italo.jpg` e `renan.jpg`.
> A pasta `originais/` guarda os arquivos como foram enviados — a foto do Renan
> foi recortada a partir dela para remover o logo da CNM e a tarja colorida do
> rodapé, que não devem aparecer em material de campanha.

Para trocar qualquer foto, basta substituir o arquivo mantendo o nome:

| Arquivo | Quem | Onde aparece |
|---|---|---|
| `italo.jpg` | Ítalo Moreira | Foto principal do topo **e** avatar do Instagram |
| `renan.jpg` | Renan Santos | Seção "Nosso candidato a Presidente" |

E, opcionalmente, os posts do feed em `assets/insta/`:

| Arquivos | Onde aparece |
|---|---|
| `post-01.jpg` … `post-09.jpg` | Grade 3×3 do celular na seção Instagram |

Cada post que existir substitui o card de texto correspondente e continua
clicando para o perfil. Pode subir só alguns — os que faltarem seguem como
card tipográfico. O melhor formato é vertical (360×640, print do próprio feed).

Salvou os arquivos? Recarregue o `index.html` — as fotos entram sozinhas.
Sem os arquivos, a página continua funcionando e mostra as molduras douradas
de reserva (nada quebra).

## Dicas de enquadramento

- **Vertical funciona melhor** (proporção 4:5, tipo 1200×1500 px).
- O rosto deve estar no **terço superior** da imagem — o corte é automático
  e favorece essa área.
- Marca d'água, logo ou tarja no **rodapé** da foto some sozinha: existe um
  degradê que apaga a base da imagem.
- Fundo colorido (laranja, azul, verde) não é problema: a página aplica um
  tratamento preto-e-amarelo que unifica qualquer foto na identidade do Missão.

## Quer ajustar o corte de uma foto específica?

No `index.html`, na moldura correspondente, mude o valor de `--pos`
(horizontal e vertical, em %):

```html
<div class="photo-frame" style="--pos:50% 18%">
```

Menor o segundo número, mais alto o corte fica na foto.
