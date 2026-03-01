const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// CONFIGURAÇÃO DO FIREBASE ADMIN
// Certifique-se de que as variáveis de ambiente estão configuradas no Render!
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com"
});

const db = admin.database();

// =======================================================
// 1. WEBHOOK DO MERCADO PAGO (PROPORCIONAL E CONTABILIZADO)
// =======================================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    let paymentId = req.query.id || (req.body.data && req.body.data.id);

    if (paymentId) {
        try {
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });

            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                const maquina = "Maquina-01"; // Identificado pelo Caixa no MP

                // 1. Calcula pulsos (R$ 2 = 1, R$ 5 = 3)
                let pulsos = Math.floor(valor / 2);
                if (valor >= 5 && valor < 10) pulsos = 3;

                // 2. Libera o crédito na placa
                const refCredito = db.ref(`/Vending-Machines/${maquina}/jogadas_pendentes`);
                refCredito.transaction(current => (current || 0) + pulsos);

                // 3. Registra a venda para o faturamento do Dashboard
                const refVendas = db.ref(`/Vending-Machines/${maquina}/historico_vendas`);
                refVendas.push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId
                });

                console.log(`✅ Venda de R$ ${valor} registrada para ${maquina}`);
            }
        } catch (error) {
            console.error("Erro no Webhook:", error.message);
        }
    }
});

// =======================================================
// 2. DASHBOARD DE ADMINISTRAÇÃO (O SEU PAINEL)
// =======================================================
app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin - Gruas Gravatá</title>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js"></script>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-database.js"></script>
            <style>
                :root { --bg: #0f172a; --card: #1e293b; --accent: #38bdf8; --danger: #ef4444; --success: #22c55e; }
                body { font-family: sans-serif; background: var(--bg); color: white; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
                .grid { display: grid; gap: 20px; width: 100%; max-width: 500px; }
                .card { background: var(--card); padding: 20px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); border: 1px solid #334155; }
                .stat { font-size: 2.5rem; font-weight: bold; color: var(--accent); margin: 10px 0; }
                .status-tag { padding: 4px 12px; border-radius: 99px; font-size: 0.8rem; font-weight: bold; }
                .online { background: #14532d; color: #4ade80; }
                .offline { background: #450a0a; color: #f87171; }
                .controls { display: flex; gap: 10px; margin-top: 15px; }
                button { flex: 1; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.2s; background: #334155; color: white; }
                button:active { transform: scale(0.95); }
                .btn-primary { background: var(--accent); color: #0f172a; }
                .btn-danger { background: #450a0a; color: #f87171; border: 1px solid var(--danger); }
            </style>
        </head>
        <body>
            <h2 style="margin-bottom: 30px;">🕹️ Painel Gruas Gravatá</h2>
            
            <div class="grid">
                <div class="card">
                    <span style="color: #94a3b8; text-transform: uppercase; font-size: 0.8rem;">Faturamento Total</span>
                    <div class="stat" id="faturamento">R$ 0,00</div>
                    <span id="contagem-vendas" style="color: #94a3b8;">0 vendas registradas</span>
                </div>

                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin: 0;">Máquina 01</h3>
                        <span id="tag-status" class="status-tag offline">OFFLINE</span>
                    </div>
                    <p style="color: #94a3b8; font-size: 0.9rem;">Visto por último: <span id="visto-ultimo">--:--</span></p>
                    
                    <div class="controls">
                        <button class="btn-primary" onclick="comando('CREDITO')">🎟️ +1 Crédito</button>
                        <button class="btn-danger" onclick="comando('REINICIAR')">🔄 Reset</button>
                    </div>
                </div>
            </div>

            <script>
                const firebaseConfig = { databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com" };
                firebase.initializeApp(firebaseConfig);
                const db = firebase.database();

                // 1. MONITORAR FATURAMENTO
                db.ref('/Vending-Machines/Maquina-01/historico_vendas').on('value', snap => {
                    let total = 0;
                    let qtd = 0;
                    snap.forEach(venda => {
                        total += venda.val().valor;
                        qtd++;
                    });
                    document.getElementById('faturamento').innerText = 'R$ ' + total.toLocaleString('pt-BR', {minimumFractionDigits: 2});
                    document.getElementById('contagem-vendas').innerText = qtd + ' vendas registradas';
                });

                // 2. MONITORAR STATUS (PING)
                db.ref('/Vending-Machines/Maquina-01/ultimo_ping').on('value', snap => {
                    const diff = (Date.now() - snap.val()) / 1000;
                    const tag = document.getElementById('tag-status');
                    if (diff < 90) {
                        tag.innerText = "ONLINE";
                        tag.className = "status-tag online";
                    } else {
                        tag.innerText = "OFFLINE";
                        tag.className = "status-tag offline";
                    }
                    document.getElementById('visto-ultimo').innerText = new Date(snap.val()).toLocaleTimeString();
                });

                // 3. COMANDOS
                function comando(tipo) {
                    if (tipo === 'CREDITO') {
                        db.ref('/Vending-Machines/Maquina-01/jogadas_pendentes').transaction(c => (c || 0) + 1);
                    } else {
                        if(confirm('Reiniciar a placa remotamente?')) {
                            db.ref('/Vending-Machines/Maquina-01/comando').set('REINICIAR');
                        }
                    }
                }
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
