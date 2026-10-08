"""Transforma o JSON cru da API do Cloudflare numa tabela legível.

Uso: python gerar-leitura.py <zona.json> <saida.md> "<titulo>"
"""

import json
import sys
from pathlib import Path

entrada, saida, titulo = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
registros = json.loads(entrada.read_text(encoding="utf-8"))["result"]

linhas = [
    f"# {titulo}",
    "",
    f"Cópia crua: `{entrada.name}`. Esta tabela é a leitura humana do mesmo estado.",
    "",
    "| tipo | nome | conteúdo | prio | proxy | id |",
    "|---|---|---|---|---|---|",
]
for r in sorted(registros, key=lambda r: (r["type"], r["name"])):
    linhas.append(
        f"| {r['type']} | {r['name']} | {str(r['content'])[:70]} | {r.get('priority', '')} "
        f"| {'sim' if r.get('proxied') else 'não'} | {r['id']} |"
    )
saida.write_text("\n".join(linhas) + "\n", encoding="utf-8")
print(f"{len(registros)} registros -> {saida}")
