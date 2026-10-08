"""Desenha a moldura do emulador com a marca da Avila.

Uso: python gerar-skin.py <caminho-da-logo.png> <pasta-de-saida>
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# tela do Pixel 6, o perfil usado no AVD
TELA_L, TELA_A = 1080, 2400
BORDA = 46   # lateral
TOPO = 150   # faixa de cima, onde entra a marca
BASE = 110   # queixo
PRETO = (10, 12, 15, 255)
LOGO = 96    # lado da marca desenhada


def gerar(logo_png: Path, saida: Path) -> None:
    saida.mkdir(parents=True, exist_ok=True)

    largura = TELA_L + BORDA * 2
    altura = TELA_A + TOPO + BASE

    img = Image.new("RGBA", (largura, altura), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, largura - 1, altura - 1], radius=90, fill=PRETO)
    # o recorte transparente e por onde o emulador mostra o Android
    d.rectangle([BORDA, TOPO, BORDA + TELA_L - 1, TOPO + TELA_A - 1], fill=(0, 0, 0, 0))

    logo = Image.open(logo_png).convert("RGBA").resize((LOGO, LOGO), Image.LANCZOS)
    img.alpha_composite(logo, ((largura - LOGO) // 2, (TOPO - LOGO) // 2))
    img.save(saida / "background.png")

    layout = f"""parts {{
    device {{
        display {{
            width   {TELA_L}
            height  {TELA_A}
            x       0
            y       0
        }}
    }}
    portrait {{
        background {{
            image   background.png
        }}
        buttons {{
        }}
    }}
}}

layouts {{
    portrait {{
        width     {largura}
        height    {altura}
        color     0x0a0c0f
        event     EV_SW:0:1
        part1 {{
            name    portrait
            x       0
            y       0
        }}
        part2 {{
            name    device
            x       {BORDA}
            y       {TOPO}
        }}
    }}
}}
"""
    (saida / "layout").write_text(layout, encoding="utf-8")
    print(f"skin gerado em {saida} ({largura}x{altura})")


if __name__ == "__main__":
    gerar(Path(sys.argv[1]), Path(sys.argv[2]))
