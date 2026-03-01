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
        console.error("Erro ao liberar crédito:", error.message);
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
                const maquinaID = response.data.external_reference || "Maquina-01";
                
                liberarCredito(maquinaID, pulsos);

                db.ref(`Vending-Machines/${maquinaID}/historico_vendas`).push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId,
                    metodo: 'PIX'
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
    // Redireciona de volta para a aba Minhas Máquinas com alerta de sucesso
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.post('/reiniciar-maquina', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}`).update({ "comando": "REINICIAR" });
    res.redirect('/painel?status=reiniciando');
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    liberarCredito(maquina, parseInt(req.query.pulsos) || 1);
    res.send("OK");
});

// =======================================================
// DASHBOARD (COM SISTEMA DE ABAS / NAVEGAÇÃO)
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

    // Qual aba deve vir aberta por padrão (útil para quando salvar as configurações)
    const abaAtiva = req.query.aba === 'maquinas' ? 'view-maquinas' : 'view-dashboard';
    const alertMsg = req.query.status === 'sucesso' ? '✅ Configuração salva com sucesso!' : '';

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PayXyz Clone - Dashboard</title>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js"></script>
            <script src="https://www.gstatic.com/firebasejs/8.10.0/firebase-database.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <style>
                :root { --blue: #1a56db; --bg: #f4f5f7; --sidebar: #ffffff; --text: #1f2937; --text-muted: #6b7280; --border: #e5e7eb; }
                body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
                
                /* SIDEBAR */
                .sidebar { width: 250px; background: var(--sidebar); border-right: 1px solid var(--border); padding: 20px 0; display: flex; flex-direction: column; }
                .logo { font-size: 24px; font-weight: bold; padding: 0 20px 20px; border-bottom: 1px solid var(--border); color: #111827; }
                .logo span { color: var(--blue); }
                .menu-item { padding: 15px 20px; color: var(--text-muted); text-decoration: none; font-weight: 500; display: flex; align-items: center; gap: 10px; cursor: pointer; border-left: 4px solid transparent; }
                .menu-item.active { background: #eff6ff; color: var(--blue); border-left-color: var(--blue); }
                .menu-item:hover:not(.active) { background: #f9fafb; color: var(--text); }

                /* MAIN CONTENT */
                .main { flex: 1; padding: 30px; overflow-y: auto; }
                .view-section { display: none; }
                .view-section.active { display: block; }
                
                .card { background: #fff; border-radius: 10px; border: 1px solid var(--border); padding: 25px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
                h2 { margin-top: 0; font-size: 18px; color: #111827; margin-bottom: 20px; }
                
                .grid-top { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
                .grid-maquinas { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
                
                /* CHART AREA */
                .chart-container { height: 300px; width: 100%; }

                /* MODAL POPUP */
                .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: center; }
                .modal { background: #fff; width: 400px; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); text-align: center; }
                .modal-header { background: #f3f4f6; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; font-weight: bold; border-bottom: 1px solid var(--border); }
                .close-btn { cursor: pointer; font-size: 20px; color: #9ca3af; }
                .modal-body { padding: 30px 40px; }
                .modal-body h3 { margin: 0 0 10px; font-size: 22px; color: #374151; font-weight: 600; }
                .modal-body p { color: #6b7280; font-size: 14px; margin-bottom: 25px; }
                
                .input-group { display: flex; gap: 10px; justify-content: center; margin-bottom: 20px; }
                .input-group input { width: 80px; padding: 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 18px; text-align: center; }
                .btn-yellow { background: #fbbf24; color: #fff; border: none; padding: 12px 20px; border-radius: 4px; font-weight: bold; font-size: 14px; cursor: pointer; transition: 0.2s; flex: 1; }
                .btn-yellow:hover { background: #f59e0b; }
                
                .modal-footer-text { font-size: 11px; color: #9ca3af; text-align: left; line-height: 1.4; border-top: 1px solid var(--border); padding-top: 15px; }

                /* STATUS TAGS */
                .status-online { background: #def7ec; color: #03543f; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
                .status-offline { background: #fde8e8; color: #9b1c1c; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }

                /* FORMULÁRIO DE CONFIGURAÇÃO */
                label { font-size: 0.85rem; color: var(--text-muted); font-weight: bold; }
                .form-input { width: 100%; padding: 10px; margin: 8px 0 15px; border-radius: 6px; border: 1px solid var(--border); box-sizing: border-box; background: #f9fafb; }
                .btn-primary { background: var(--blue); color: white; padding: 10px; border: none; border-radius: 6px; cursor: pointer; width: 100%; font-weight: bold; }
                .btn-primary:hover { background: #1e40af; }
                hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
            </style>
        </head>
        <body>
            
            <aside class="sidebar">
                <div class="logo">Gruas<span>Gravatá</span></div>
                <div style="margin-top: 20px;">
                    <a class="menu-item ${abaAtiva === 'view-dashboard' ? 'active' : ''}" onclick="mudarAba('view-dashboard', this)">📊 Dashboard</a>
                    <a class="menu-item ${abaAtiva === 'view-maquinas' ? 'active' : ''}" onclick="mudarAba('view-maquinas', this)">🕹️ Minhas Máquinas</a>
                    <a class="menu-item" onclick="abrirModal()">🎟️ Enviar Créditos</a>
                </div>
            </aside>

            <main class="main">
                ${alertMsg ? \`<div style="background: #def7ec; color: #03543f; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #bcdecb;">\${alertMsg}</div>\` : ''}

                <div id="view-dashboard" class="view-section ${abaAtiva === 'view-dashboard' ? 'active' : ''}">
                    <div class="grid-top">
                        <div class="card">
                            <h2>Faturamento <span style="font-weight: normal; color: #6b7280; font-size: 14px;">Por dia</span></h2>
                            <div class="chart-container">
                                <canvas id="graficoFaturamento"></canvas>
                            </div>
                        </div>

                        <div style="display: flex; flex-direction: column; gap: 20px;">
                            <div class="card" style="margin-bottom: 0;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <h2>Total Diário</h2>
                                    <span id="status-tag" class="status-offline">OFFLINE</span>
                                </div>
                                <h1 id="faturamento-hoje" style="font-size: 36px; margin: 10px 0; color: var(--blue);">R$ 0,00</h1>
                                <p style="color: var(--text-muted); font-size: 14px; margin: 0;">Faturado hoje em todas as máquinas</p>
                            </div>
                            
                            <div class="card" style="margin-bottom: 0;">
                                <h2>Ações Rápidas</h2>
                                <button onclick="abrirModal()" style="width: 100%; padding: 12px; background: #fff; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: bold; color: #374151;">+ Inserir Crédito Remoto</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="view-maquinas" class="view-section ${abaAtiva === 'view-maquinas' ? 'active' : ''}">
                    <h2 style="font-size: 24px;">Controle de Máquinas</h2>
                    <p style="color: var(--text-muted); margin-bottom: 25px; margin-top: -10px;">Gerencie suas gruas cadastradas, verifique o status e calibre os componentes eletrônicos.</p>
                    
                    <div class="grid-maquinas">
                        <div class="card" style="margin-bottom: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                                <div>
                                    <h3 style="margin: 0; font-size: 18px; color: #111827;">🕹️ Maquina-01</h3>
                                    <span style="font-size: 12px; color: var(--text-muted);">Local: Gravatá - PE</span>
                                </div>
                                <span id="status-tag-lista" class="status-offline">OFFLINE</span>
                            </div>
                            
                            <p style="color: var(--text-muted); font-size: 13px; margin: 0;">Último ping: <span id="ultimo-ping">--:--</span></p>
                            <p style="color: var(--text-muted); font-size: 13px; margin: 5px 0 0 0;">Placa: Wemos D1 Mini Pro (ESP8266)</p>
                            
                            <hr>
                            
                            <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                                <button onclick="abrirModal()" style="flex: 1; padding: 10px; background: #fff; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: bold; color: #374151; font-size: 12px;">🎟️ Dar Crédito</button>
                                <form action="/reiniciar-maquina" method="POST" style="flex: 1; margin: 0;">
                                    <input type="hidden" name="maquina" value="Maquina-01">
                                    <button type="submit" onclick="return confirm('Deseja reiniciar a placa?');" style="width: 100%; padding: 10px; background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px;">🔄 Reiniciar</button>
                                </form>
                            </div>

                            <h4 style="margin: 0 0 15px 0; color: #374151;">⚙️ Calibragem do Relé (Moedeiro)</h4>
                            <form action="/salvar-config" method="POST">
                                <input type="hidden" name="maquina" value="Maquina-01">
                                
                                <label>Tempo do Pulso (Milissegundos):</label>
                                <input type="number" name="pulso" class="form-input" value="${pulsoAtual}" required>
                                
                                <label>Tempo de Pausa entre Pulsos (ms):</label>
                                <input type="number" name="pausa" class="form-input" value="${pausaAtual}" required>
                                
                                <button type="submit" class="btn-primary">💾 Salvar na Nuvem</button>
                            </form>
                        </div>

                        <div class="card" style="margin-bottom: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; border: 2px dashed #d1d5db; background: transparent; cursor: pointer;">
                            <div style="font-size: 40px; color: #9ca3af; margin-bottom: 10px;">+</div>
                            <h3 style="margin: 0; color: #6b7280;">Adicionar Máquina</h3>
                            <p style="color: #9ca3af; font-size: 12px; text-align: center;">Cadastre uma nova grua no sistema</p>
                        </div>
                    </div>
                </div>

            </main>

            <div id="modalCredito" class="modal-overlay">
                <div class="modal">
                    <div class="modal-header">
                        <span>Crédito Remoto</span>
                        <span class="close-btn" onclick="fecharModal()">&times;</span>
                    </div>
                    <div class="modal-body">
                        <h3>Incluir Crédito<br>Remotamente</h3>
                        <p>Informe a quantidade de pulsos que será enviado para sua máquina.</p>
                        
                        <div class="input-group">
                            <input type="number" id="qtdPulsos" value="1" min="1">
                            <button class="btn-yellow" onclick="enviarCredito()" id="btn-enviar-modal">ENVIAR CRÉDITO</button>
                        </div>
                        
                        <div class="modal-footer-text">
                            *Este botão executa a liberação do crédito na Máquina.
                        </div>
                    </div>
                </div>
            </div>

            <script>
                // SISTEMA DE NAVEGAÇÃO DE ABAS
                function mudarAba(idAba, elementoLista) {
                    // Esconde todas as abas
                    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
                    // Remove a cor azul de todos os links do menu
                    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
                    
                    // Mostra a aba certa e pinta o botão clicado
                    document.getElementById(idAba).classList.add('active');
