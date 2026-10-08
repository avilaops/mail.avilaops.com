"""Deixa o AVD enxuto: tira o que o webmail nao usa e aplica a moldura da marca.

Uso: python ajustar-avd.py <caminho-do-config.ini> <pasta-do-skin>
"""

import sys
from pathlib import Path

AJUSTES = {
    # aceleracao grafica: sem isso o emulador renderiza tudo em software
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "host",
    # sem cameras
    "hw.camera.back": "none",
    "hw.camera.front": "none",
    # sem audio
    "hw.audioInput": "no",
    "hw.audioOutput": "no",
    # sem cartao de memoria
    "hw.sdCard": "no",
    "sdcard.size": "0",
    # o teclado do computador digita direto no emulador
    "hw.keyboard": "yes",
    # sensores que uma caixa de e-mail nao usa
    "hw.accelerometer": "no",
    "hw.accelerometer_uncalibrated": "no",
    "hw.gyroscope": "no",
    "hw.sensors.gyroscope_uncalibrated": "no",
    "hw.gps": "no",
    "hw.sensors.humidity": "no",
    "hw.sensors.light": "no",
    "hw.sensors.magnetic_field": "no",
    "hw.sensors.magnetic_field_uncalibrated": "no",
    "hw.sensors.orientation": "no",
    "hw.sensors.pressure": "no",
    "hw.sensors.proximity": "no",
    "hw.sensors.temperature": "no",
    # recursos: dois nucleos e 2 GB dao conta de um webview
    "hw.cpu.ncore": "2",
    "hw.ramSize": "2048",
    "vm.heapSize": "256",
    "disk.dataPartition.size": "3G",
}


def ajustar(config: Path, skin: Path) -> None:
    ajustes = dict(AJUSTES)
    ajustes["skin.name"] = skin.name
    ajustes["skin.path"] = str(skin)
    ajustes["skin.dynamic"] = "no"
    ajustes["showDeviceFrame"] = "yes"

    valores: dict[str, str] = {}
    for linha in config.read_text(encoding="utf-8").splitlines():
        if "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        valores[chave.strip()] = valor.strip()

    valores.update(ajustes)
    config.write_text(
        "\n".join(f"{c}={v}" for c, v in sorted(valores.items())) + "\n",
        encoding="utf-8",
    )
    print(f"config ajustado: {config}")


if __name__ == "__main__":
    ajustar(Path(sys.argv[1]), Path(sys.argv[2]))
