# App do mail.avilaops.com

Aplicativo de celular da caixa de e-mail da Ávila Ops, para Android e iPhone.

## Como o app é feito

O webmail em `../webmail` já é um PWA: tem manifesto, service worker e web push.
O aplicativo embrulha esse mesmo webmail, em vez de reescrever a caixa de entrada
duas vezes. Uma base de código atende as duas lojas, e toda correção no webmail
chega ao celular sem novo envio de versão.

O que o embrulho acrescenta sobre o navegador:

- ícone na tela inicial das duas plataformas
- notificação nativa de mensagem nova (no iPhone o push do navegador é limitado)
- abrir anexo com os aplicativos do aparelho
- guardar a sessão sem depender do cookie do navegador

## Emulador de teste (Android)

O emulador é enxuto de propósito: imagem AOSP sem Google Play, sem câmera,
sem áudio, sem cartão de memória e sem os sensores que uma caixa de e-mail
não usa. A moldura leva a marca da Ávila.

Criar do zero (uma vez):

```powershell
pwsh -File criar-emulador.ps1
```

Subir para trabalhar:

```powershell
pwsh -File emulador.ps1
```

Opções: `-Limpar` apaga o estado do aparelho e começa do zero, `-SemJanela`
roda sem interface para teste automatizado.

O primeiro boot passa de dois minutos porque não há snapshot ainda. Os
seguintes são rápidos.

### Detalhes do emulador

| item | valor |
| --- | --- |
| nome do AVD | `avila_leve` |
| imagem | `system-images;android-35;aosp_atd;x86_64` |
| aparelho | Pixel 6 (1080x2400) |
| memória | 2 GB, 2 núcleos |
| moldura | `%LOCALAPPDATA%\Android\Sdk\skins\avila` |

`aosp_atd` é a imagem de teste automatizado do próprio Android: vem sem os
aplicativos do Google e com as animações retiradas. É a mais leve que o SDK
oferece.

### Se o emulador não subir

O erro mais comum é `Broken AVD system path`: alguma variável de ambiente
aponta para um SDK que não existe mais. Os scripts daqui já forçam
`ANDROID_SDK_ROOT` e `ANDROID_HOME` para `%LOCALAPPDATA%\Android\Sdk`, mas um
terminal aberto antes da correção continua com o valor velho até ser reaberto.

O segundo é `Running multiple emulators with the same AVD`: sobrou instância
travada de uma execução anterior. O `emulador.ps1` já mata o processo e apaga
os arquivos de trava antes de subir.
