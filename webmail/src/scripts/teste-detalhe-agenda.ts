import assert from "node:assert/strict";
import { recorrenciaEmPortugues, resumoRespostas } from "../lib/detalheAgenda";

assert.equal(recorrenciaEmPortugues(), null);
assert.equal(recorrenciaEmPortugues("FREQ=DAILY"), "Todos os dias");
assert.equal(recorrenciaEmPortugues("FREQ=WEEKLY;INTERVAL=2"), "A cada 2 semanas");
assert.equal(recorrenciaEmPortugues("FREQ=MONTHLY"), "Todo mês");
assert.equal(recorrenciaEmPortugues("FREQ=YEARLY;INTERVAL=3"), "A cada 3 anos");
assert.equal(recorrenciaEmPortugues("FREQ=WEEKLY;BYDAY=MO,WE"), "Toda semana, segunda e quarta");
assert.equal(recorrenciaEmPortugues("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), "Toda semana, terça, por 8 ocorrências");
assert.equal(recorrenciaEmPortugues("FREQ=MONTHLY;UNTIL=20271231T235959Z"), "Todo mês, até 31/12/2027");
assert.equal(recorrenciaEmPortugues("FREQ=MONTHLY;BYDAY=-1MO"), "Regra personalizada: FREQ=MONTHLY;BYDAY=-1MO");
assert.equal(recorrenciaEmPortugues("FREQ=MONTHLY;BYMONTHDAY=15"), "Regra personalizada: FREQ=MONTHLY;BYMONTHDAY=15");
assert.equal(recorrenciaEmPortugues("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2"), "Regra personalizada: FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2");
assert.equal(resumoRespostas([{ resposta: "aceito" }, { resposta: "aceito" }, { resposta: "aceito" }, { resposta: "talvez" }, { resposta: "pendente" }, { resposta: "pendente" }]), "3 sim · 1 talvez · 2 sem resposta");
assert.equal(resumoRespostas([{ resposta: "recusado" }]), "1 não");
console.log("PASSOU — 13 verificações do detalhe da agenda");
