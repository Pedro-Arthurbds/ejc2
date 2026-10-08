// Gera o código "Pix copia e cola" (BR Code, padrão do Banco Central) e o QR Code dele.
const QRCode = require("qrcode");

function semAcento(s, max) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .\-]/g, " ").replace(/\s+/g, " ").trim().toUpperCase().slice(0, max);
}

function campo(id, valor) {
  return id + String(valor.length).padStart(2, "0") + valor;
}

function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// valorCentavos: inteiro. txid: só letras e números, até 25 caracteres.
function gerarBrCode({ chave, nome, cidade, valorCentavos, txid }) {
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", String(chave).trim());
  const adicional = campo("05", String(txid || "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***");
  let corpo =
    campo("00", "01") +
    campo("01", "11") +
    campo("26", conta) +
    campo("52", "0000") +
    campo("53", "986") +
    campo("54", (valorCentavos / 100).toFixed(2)) +
    campo("58", "BR") +
    campo("59", semAcento(nome, 25) || "RECEBEDOR") +
    campo("60", semAcento(cidade, 15) || "BRASIL") +
    campo("62", adicional) +
    "6304";
  return corpo + crc16(corpo);
}

async function qrDataUrl(brcode) {
  return QRCode.toDataURL(brcode, { errorCorrectionLevel: "M", margin: 2, width: 360 });
}

module.exports = { gerarBrCode, qrDataUrl, crc16 };
