import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorEvento } from "@/components/EditorEvento";
import { EditorRecorrencia } from "@/components/EditorRecorrencia";
import { GuiaConfiguracao } from "@/components/GuiaConfiguracao";
import { NavegacaoVisoesAgenda } from "@/components/NavegacaoVisoesAgenda";
import { classeConteudoAgenda, deveMostrarGradeAgenda, rotuloCompactoAgenda } from "@/lib/apresentacaoAgenda";

let verificacoes = 0;
function igual<T>(atual: T, esperado: T, mensagem?: string) {
  assert.equal(atual, esperado, mensagem);
  verificacoes += 1;
}

igual(deveMostrarGradeAgenda("dia", false), true, "a grade do dia permanece visível sem eventos");
igual(deveMostrarGradeAgenda("semana", false), true, "a grade da semana permanece visível sem eventos");
igual(deveMostrarGradeAgenda("mes", false), true, "a grade do mês permanece visível sem eventos");
igual(deveMostrarGradeAgenda("lista", false), false, "a lista usa seu próprio estado vazio");
igual(deveMostrarGradeAgenda("semana", true), false, "um erro substitui a grade por recuperação");
igual(rotuloCompactoAgenda(new Date(2026, 9, 18), "semana", 0), "18–24 out.");
igual(rotuloCompactoAgenda(new Date(2026, 9, 18), "dia", 0), "18 de out.");
igual(classeConteudoAgenda("semana"), "min-h-0 flex-1 overflow-hidden");
igual(classeConteudoAgenda("lista"), "rolagem-fina min-h-0 flex-1 overflow-y-auto");

const agenda = [{ id: "principal", nome: "Agenda", cor: "#2563EB", padrao: true, ordem: 0, quantidadeEventos: 0 }];
const editor = renderToStaticMarkup(
  <EditorEvento
    data={new Date(2026, 9, 18, 9)}
    agendas={agenda}
    onFechar={() => undefined}
    onSalvar={() => undefined}
  />,
);

igual(editor.includes("Mais opções"), true, "novo evento começa no fluxo compacto");
igual(editor.includes(">Local<"), false, "campos avançados ficam recolhidos inicialmente");
igual(editor.includes("overflow-x-hidden"), true, "o painel impede rolagem horizontal");
igual(editor.includes("rodape-seguro"), true, "o rodapé respeita a área segura do aparelho");
igual(editor.indexOf(">Título<") < editor.indexOf(">Agenda<"), true, "o título vem antes da agenda no fluxo principal");
igual((editor.match(/max-w-full/g) ?? []).length >= 3, true, "o editor e as datas respeitam a largura móvel");

const recorrencia = renderToStaticMarkup(<EditorRecorrencia regra="" inicio={new Date(2026, 9, 18, 9)} onMudar={() => undefined} />);
igual((recorrencia.match(/Não se repete/g) ?? []).length, 1, "a opção sem recorrência não é repetida");

const guia = renderToStaticMarkup(<GuiaConfiguracao host="mail.avilaops.com" />);
igual(guia.includes('id="agenda"'), true, "o guia oferece um destino direto para configurar a agenda");
igual(guia.includes("https://mail.avilaops.com/dav/"), true, "o endereço CalDAV aparece completo");
igual(guia.includes("break-all"), true, "o endereço CalDAV permanece legível em telas estreitas");
igual(guia.indexOf("Sincronizar sua agenda") < guia.indexOf("Servidores e portas"), true, "a agenda aparece antes da configuração avançada de e-mail");

const visoes = renderToStaticMarkup(<NavegacaoVisoesAgenda visao="lista" onMudar={() => undefined} />);
igual((visoes.match(/<button/g) ?? []).length, 4, "as quatro visões ficam acessíveis sem abrir o menu lateral");
igual(visoes.includes('aria-current="page"'), true, "a visão atual é anunciada para tecnologia assistiva");
igual(visoes.includes("Dia") && visoes.includes("Semana") && visoes.includes("Mês") && visoes.includes("Lista"), true);

console.log(`PASSOU — ${verificacoes} verificações da experiência móvel da agenda`);
