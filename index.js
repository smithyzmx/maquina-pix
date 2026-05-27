const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 

const FIREBASE_URL = "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/";

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
    }
    console.log("✅ Ligado ao Firebase!");
} catch (e) {
    console.log("❌ Erro na configuração: " + e.message);
}

const db = admin.database();

// =======================================================
// LÓGICA DE HARDWARE E PAGAMENTOS 
// =======================================================
async function liberarCredito(maquinaID, pulsos) {
    const ref = db.ref(`Vending-Machines/${maquinaID}`);
    try {
        await ref.update({
            "jogadas_pendentes": admin.database.ServerValue.increment(pulsos),
            "ultima_venda": new Date().toLocaleString("pt-BR", {timeZone: "America/Recife"})
        });
        console.log(`✅ Adicionado +${pulsos} pulsos para ${maquinaID}`);

        setTimeout(async () => {
            const snapshot = await ref.child("jogadas_pendentes").once("value");
            if (snapshot.val() > 0) {
                await ref.update({ "jogadas_pendentes": 0 });
                console.log(`❌ TIMEOUT: ${maquinaID} offline. Fila zerada.`);
            }
        }, 60000); 
    } catch (error) {
        console.error("Erro ao libertar crédito:", error.message);
    }
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    let paymentId = null;

    if (req.query.topic === 'payment' && req.query.id) paymentId = req.query.id;
    else if (req.body.data && req.body.data.id) paymentId = req.body.data.id;
    else if (req.body.resource) paymentId = req.body.resource.split('/').pop();

    if (paymentId) {
        try {
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });
            
            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                const pulsos = Math.floor(valor); 
                
                // ==========================================
                // 🕵️ O DETETIVE DE MÁQUINAS (COM POS_ID)
                // ==========================================
                const refExterna = response.data.external_reference || "";
                const descricao = response.data.description || "";
                const titulo = response.data.title || "";
                const posId = response.data.pos_id || "";

                // Função que procura a palavra exata "GRUA-" seguida de 4 letras/números
                const extrairGrua = (texto) => {
                    const regex = /GRUA-[A-Z0-9]{4}/i;
                    const match = String(texto).match(regex);
                    return match ? match[0].toUpperCase() : null;
                };

                // Vasculha os textos tentando achar o nome
                const gruaEncontrada = extrairGrua(refExterna) || extrairGrua(descricao) || extrairGrua(titulo);

                // Define a máquina: Tenta o POS_ID (Caixa), depois o detetive, e por último o padrão
                const maquinaID = posId || gruaEncontrada || "Maquina-01";
                // ==========================================

                // === TRAVA DE SEGURANÇA: CONTRA ATRASO DO MERCADO PAGO ===
                const dataPagamento = new Date(response.data.date_approved);
                const dataAgora = new Date();
                const diferencaEmMinutos = (dataAgora - dataPagamento) / (1000 * 60);

                if (diferencaEmMinutos > 3) {
                    console.log(`⏳ PIX muito antigo (${Math.floor(diferencaEmMinutos)} min de atraso). Guardando no histórico, mas NÃO liberando jogada na ${maquinaID}.`);
                } else {
                    console.log(`✅ PIX fresquinho e aprovado! Liberando jogada na ${maquinaID}.`);
                    liberarCredito(maquinaID, pulsos);
                }

                // Sempre anota no histórico, mesmo que seja um PIX atrasado
                db.ref(`Vending-Machines/${maquinaID}/historico_vendas`).push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId,
                    metodo: 'PIX',
                    status_liberacao: diferencaEmMinutos > 3 ? 'Bloqueado (Atraso)' : 'Liberado'
                });
            }
        } catch (error) {
            console.error("Erro no Webhook:", error.message);
        }
    }
});

app.post('/salvar-config', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}/configuracoes`).update({
        "tempo_pulso_ms": parseInt(req.body.pulso) || 100,
        "tempo_pausa_ms": parseInt(req.body.pausa) || 400
    });
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.post('/reiniciar-maquina', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}`).update({ "comando": "REINICIAR" });
    res.redirect('/painel?aba=maquinas&status=reiniciando');
});

app.post('/deletar-maquina', async (req, res) => {
    const maquina = req.body.maquina;
    if(maquina) {
        await db.ref(`Vending-Machines/${maquina}`).remove();
    }
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    liberarCredito(maquina, parseInt(req.query.pulsos) || 1);
    res.send("OK");
});

// =======================================================
// DASHBOARD DINÂMICA (AUTO-DESCOBERTA RESPONSIVA)
// =======================================================
app.get('/painel', (req, res) => {
    const abaAtiva = req.query.aba === 'maquinas' ? 'view-maquinas' : 'view-dashboard';
    const alertMsg = req.query.status === 'sucesso' ? '✅ Ação realizada com sucesso!' : '';

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Painel - Controle de Gruas</title>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js"></script>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-database.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <style>
                :root { --blue: #1a56db; --bg: #f4f5f7; --sidebar: #ffffff; --text: #1f2937; --text-muted: #6b7280; --border: #e5e7eb; }
                body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
                .sidebar { width: 250px; background: var(--sidebar); border-right: 1px solid var(--border); padding: 20px 0; display: flex; flex-direction: column; flex-shrink: 0; }
                .logo { font-size: 24px; font-weight: bold; padding: 0 20px 20px; border-bottom: 1px solid var(--border); color: #111827; }
                .logo span { color: var(--blue); }
                .menu-container { margin-top: 20px; }
                .menu-item { padding: 15px 20px; color: var(--text-muted); text-decoration: none; font-weight: 500; display: flex; align-items: center; gap: 10px; cursor: pointer; border-left: 4px solid transparent; }
                .menu-item.active { background: #eff6ff; color: var(--blue); border-left-color: var(--blue); }
                .menu-item:hover:not(.active) { background: #f9fafb; color: var(--text); }
                .main { flex: 1; padding: 30px; overflow-y: auto; }
                .view-section { display: none; }
                .view-section.active { display: block; }
                .card { background: #fff; border-radius: 10px; border: 1px solid var(--border); padding: 25px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
                h2 { margin-top: 0; font-size: 18px; color: #111827; margin-bottom: 20px; }
                .grid-top { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
                .grid-maquinas { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
                .chart-container { height: 300px; width: 100%; }
                .status-online { background: #def7ec; color: #03543f; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
                .status-offline { background: #fde8e8; color: #9b1c1c; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
                label { font-size: 0.85rem; color: var(--text-muted); font-weight: bold; }
                .form-input { width: 100%; padding: 10px; margin: 8px 0 15px; border-radius: 6px; border: 1px solid var(--border); box-sizing: border-box; background: #f9fafb; }
                .btn-primary { background: var(--blue); color: white; padding: 10px; border: none; border-radius: 6px; cursor: pointer; width: 100%; font-weight: bold; }
                .btn-primary:hover { background: #1e40af; }
                hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
                
                /* Tabela Histórico */
                .tabela-historico { width: 100%; border-collapse: collapse; font-size: 14px; }
                .tabela-historico th { text-align: left; padding: 12px; border-bottom: 2px solid var(--border); color: var(--text-muted); font-weight: 600; }
                .tabela-historico td { padding: 12px; border-bottom: 1px solid var(--border); }
                .tabela-historico tr:hover { background-color: #f9fafb; }

                /* MODAL */
                .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: center; padding: 15px; box-sizing: border-box; }
                .modal { background: #fff; width: 100%; max-width: 400px; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); text-align: center; }
                .modal-header { background: #f3f4f6; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center
