/**
 * Recebe as inscrições do sistema e grava uma linha por inscrição na planilha.
 * Configuração (Configurações do projeto > Propriedades do script):
 *   SEGREDO = mesma senha que você colocar em SHEETS_SECRET no servidor
 */
var ABA = 'Inscrições';
var CABECALHO = ['ID', 'Inscrito em', 'Nome', 'Idade', 'WhatsApp', 'EJC'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var d = JSON.parse(e.postData.contents);
    var segredo = PropertiesService.getScriptProperties().getProperty('SEGREDO');
    if (!segredo || d.segredo !== segredo) return resposta({ ok: false, erro: 'segredo invalido' });

    var planilha = SpreadsheetApp.getActiveSpreadsheet();
    var aba = planilha.getSheetByName(ABA) || planilha.insertSheet(ABA);
    if (aba.getLastRow() === 0) {
      aba.appendRow(CABECALHO);
      aba.setFrozenRows(1);
      aba.getRange(1, 1, 1, CABECALHO.length).setFontWeight('bold');
    }

    // Se o ID já está na planilha, não duplica (o servidor pode reenviar após uma falha de rede).
    var ultima = aba.getLastRow();
    if (ultima > 1) {
      var ids = aba.getRange(2, 1, ultima - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(d.id)) return resposta({ ok: true, repetido: true });
      }
    }

    var quando = Utilities.formatDate(new Date(d.criado_em), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
    var linha = [String(d.id), quando, String(d.nome), String(d.idade), String(d.whatsapp),
                 String(d.ejc)];
    var destino = aba.getRange(ultima + 1, 1, 1, linha.length);
    destino.setNumberFormat('@');   // grava tudo como texto: nada vira fórmula
    destino.setValues([linha]);
    return resposta({ ok: true });
  } catch (err) {
    return resposta({ ok: false, erro: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function resposta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
