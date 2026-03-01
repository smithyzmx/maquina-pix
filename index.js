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
    console.log("✅ Conectado ao Firebase!");
} catch (e) {
    console.log("❌ Erro na configuração: " + e.message);
}

const db = admin.database();

// ⏳ FUNÇÃO DE CRÉDITO COM FILA DE ESPERA (INCREMENTO)
async function liberarCredito(maquinaID, pulsos) {
    const ref = db.ref(`Vending-Machines/${maquinaID}`);
    try {
        await ref.update({
            "jogadas_pendentes": admin.database.ServerValue.increment(pulsos),
            "ultima_venda": new Date().toLocaleString("pt-BR", {timeZone: "America/Recife"})
        });
        console.log(`✅ Adicionado +${pulsos} pulsos para ${maquinaID}. Fila atualizada!`);

        setTimeout(async () => {
            const snapshot = await ref.child("jogadas_pendentes").once("value");
            const pendentes = snapshot.val();
            if (pendentes > 0) {
                await ref.update({ "jogadas_pendentes": 0 });
                console.log(`❌ TIMEOUT: ${maquinaID} offline. Fila zerada.`);
            }
        }, 60000); 
    } catch (error) {
        console.error("Erro ao liberar crédito:", error.message);
    }
}

// WEBHOOK & IPN DO MERCADO PAGO (HÍBRIDO)
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    let paymentId = null;

    if (req.query.topic === 'payment' && req.query.id) {
        paymentId = req.query.id;
        console.log("🔔 IPN Recebido! ID:", paymentId);
    } 
    else if (req.body.data && req.body.data.id) {
        paymentId = req.body.data.id;
        console.log("🔔 Webhook Recebido! ID:", paymentId);
    } 
    else if (req.body.resource) {
        paymentId = req.body.resource.split('/').pop();
        console.log("🔔 Webhook (Resource) Recebido! ID:", paymentId);
    }

    if (paymentId) {
        try {
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });
            
            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                const pulsos = Math.floor(valor); 
                const maquinaID = response.data.external_reference || "Maquina-01";
                
                console.log(`💰 Pagamento Aprovado: R$ ${valor}. Liberando ${pulsos} pulsos para ${maquinaID}`);
                liberarCredito(maquinaID, pulsos);

                // ====================================================
                // 📊 REGISTRO DE VENDAS PARA A DASHBOARD ALIMENTAR O GRÁFICO
                // ====================================================
                db.ref(`Vending-Machines/${maquinaID}/historico_vendas`).push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId
                });
            }
        } catch (error) {
            console.error("❌ Erro ao consultar Mercado Pago:", error.message);
        }
    }
});

// ROTA: SALVAR CONFIGURAÇÕES NA NUVEM
app.post('/salvar-config', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}/configuracoes`).update({
        "tempo_pulso_ms": parseInt(req.body.pulso) || 100,
        "tempo_pausa_ms": parseInt(req.body.pausa) || 400
    });
    res.redirect('/painel?status=sucesso');
});

// ROTA: ENVIAR COMANDO DE REINICIAR
app.post('/reiniciar-maquina', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}`).update({
        "comando": "REINICIAR"
    });
    res.redirect('/painel?status=reiniciando');
});

// =======================================================
// DASHBOARD PROFISSIONAL (DARK THEME + TEMPO REAL)
// =======================================================
app.get('/painel', async (req, res) => {
    let pulsoAtual = 100, pausaAtual = 400;
    
    try {
        const snapConfig = await db.ref('Vending-Machines/Maquina-01/configuracoes').once('value');
        if(snapConfig.exists()){
            pulsoAtual = snapConfig.val().tempo_pulso_ms || 100;
            pausaAtual = snapConfig.val().tempo_pausa_ms || 400;
        }
    } catch(e) {}

    const mensagem = req.query.status === 'sucesso' ? '<div class="alert success">✅ Configurações de Relé salvas com sucesso!</div>' : 
                     req.query.status === 'reiniciando' ? '<div class="alert warning">🔄 Comando de reinício enviado para a máquina!</div>' : '';

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dash - Gruas Gravatá</title>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js"></script>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-database.js"></script>
            <style>
                :root { --bg: #0f172a; --card: #1e293b; --accent: #38bdf8; --danger: #ef4444; --success: #22c55e; --text: #f8fafc; --text-muted: #94a3b8; }
                body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
                .container { width: 100%; max-width: 800px; }
                .header { text-align: center; margin-bottom: 30px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
                .card { background: var(--card); padding: 25px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); border: 1px solid #334155; }
                h3 { margin-top: 0; color: var(--accent); display: flex; justify-content: space-between; align-items: center; }
                .stat { font-size: 2.8rem; font-weight: bold; color: var(--text); margin: 10px 0; }
                .status-tag { padding: 6px 14px; border-radius: 99px; font-size: 0.85rem; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
                .online { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid var(--success); }
                .offline { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
                
                label { font-size: 0.9rem; color: var(--text-muted); }
                input[type="number"] { width: 100%; padding: 12px; margin: 8px 0 20px 0; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: white; box-sizing: border-box; font-size: 1rem; }
                button { width: 100%; padding: 14px; border: none; border-radius: 8px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: 0.2s; margin-bottom: 10px; }
                button:active { transform: scale(0.98); }
                .btn-primary { background: var(--accent); color: #0f172a; }
                .btn-success { background: var(--success); color: white; }
                .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
                .btn-danger:hover { background: rgba(239, 68, 68, 0.1); }
                
                .alert { padding: 15px; border-radius: 8px; margin-bottom: 20px; text-align: center; font-weight: bold; }
                .alert.success { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid var(--success); }
                .alert.warning { background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid #f59e0b; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0; color: var(--accent);">🕹️ Gruas Gravatá</h1>
                    <p style="color: var(--text-muted); margin-top: 5px;">Painel de Controle Cloud</p>
                </div>

                ${mensagem}

                <div class="grid">
                    <div class="card">
                        <h3>Visão Geral <span id="tag-status" class="status-tag offline">OFFLINE</span></h3>
                        <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: -10px;">Último sinal: <span id="visto-ultimo">--:--</span></p>
                        
                        <div style="margin-top: 30px;">
                            <span style="color: var(--text-muted); font-size: 0.9rem;">Faturamento Hoje</span>
                            <div class="stat" id="faturamento">R$ 0,00</div>
                            <span id="contagem-vendas" style="color: var(--accent); font-size: 0.9rem;">0 jogadas pagas</span>
                        </div>
                    </div>

                    <div class="card">
                        <h3 style="color: #f8fafc;">⚙️ Calibrar Relé</h3>
                        <form action="/salvar-config" method="POST">
                            <input type="hidden" name="maquina" value="Maquina-01">
                            <label>Tempo do Pulso Ativado (ms):</label>
                            <input type="number" name="pulso" value="${pulsoAtual}" required>
                            
                            <label>Tempo de Pausa entre Pulsos (ms):</label>
                            <input type="number" name="pausa" value="${pausaAtual}" required>
                            
                            <button type="submit" class="btn-primary">💾 Salvar na Nuvem</button>
                        </form>
                    </div>

                    <div class="card" style="grid-column: 1 / -1; display: flex; gap: 15px; flex-wrap: wrap; background: #0f172a;">
                        <div style="flex: 1; min-width: 250px;">
                            <h4 style="margin-top: 0;">Ferramentas Rápidas</h4>
                            <button class="btn-success" onclick="liberar('Maquina-01', 1)" id="btn-teste">🎟️ Inserir 1 Crédito (Cortesia)</button>
                            <form action="/reiniciar-maquina" method="POST" style="margin:0;">
                                <input type="hidden" name="maquina" value="Maquina-01">
                                <button type="submit" class="btn-danger" onclick="return confirm('Deseja forçar o reinício da placa remotamente?');">🔄 Reiniciar Máquina (Reset)</button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                // Conexão Live com o Firebase (A mágica do tempo real)
                const firebaseConfig = { databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com" };
                firebase.initializeApp(firebaseConfig);
                const db = firebase.database();

                // 1. LER FATURAMENTO EM TEMPO REAL
                db.ref('/Vending-Machines/Maquina-01/historico_vendas').on('value', snap => {
                    let total = 0;
                    let qtd = 0;
                    
                    // Pega a meia-noite de hoje para somar só o dinheiro do dia
                    const hoje = new Date();
                    hoje.setHours(0,0,0,0);
                    
                    snap.forEach(venda => {
                        const dados = venda.val();
                        if(dados.data >= hoje.getTime()) {
                            total += dados.valor;
                            qtd++;
                        }
                    });
                    
                    document.getElementById('faturamento').innerText = 'R$ ' + total.toLocaleString('pt-BR', {minimumFractionDigits: 2});
                    document.getElementById('contagem-vendas').innerText = qtd + ' jogadas pagas hoje';
                });

                // 2. LER STATUS PING EM TEMPO REAL
                db.ref('/Vending-Machines/Maquina-01/ultimo_ping').on('value', snap => {
                    if(!snap.exists()) return;
                    
                    const diffSegundos = (Date.now() - snap.val()) / 1000;
                    const tag = document.getElementById('tag-status');
                    
                    if (diffSegundos < 120) { // Menos de 2 minutos = ONLINE
                        tag.innerText = "ONLINE";
                        tag.className = "status-tag online";
                    } else {
                        tag.innerText = "OFFLINE";
                        tag.className = "status-tag offline";
                    }
                    document.getElementById('visto-ultimo').innerText = new Date(snap.val()).toLocaleTimeString('pt-BR');
                });

                // 3. BOTÃO DE CORTESIA (WEBHOOK MANUAL)
                function liberar(id, qtd) {
                    const btn = document.getElementById('btn-teste');
                    const textoOriginal = btn.innerText;
                    btn.innerText = 'Enviando...';
                    
                    fetch('/webhook-manual?maquina=' + id + '&pulsos=' + qtd)
                    .then(() => {
                        btn.innerText = '✅ Crédito Enviado!';
                        setTimeout(() => btn.innerText = textoOriginal, 3000);
                    });
                }
            </script>
        </body>
        </html>
    `);
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    liberarCredito(maquina, parseInt(req.query.pulsos) || 1);
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online rodando a Dashboard!"));
