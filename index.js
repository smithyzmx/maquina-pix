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
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.post('/reiniciar-maquina', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}`).update({ "comando": "REINICIAR" });
    res.redirect('/painel?aba=maquinas&status=reiniciando');
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
                
                /* MODAL */
                .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: center; padding: 15px; box-sizing: border-box; }
                .modal { background: #fff; width: 100%; max-width: 400px; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); text-align: center; }
                .modal-header { background: #f3f4f6; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; font-weight: bold; border-bottom: 1px solid var(--border); }
                .close-btn { cursor: pointer; font-size: 24px; color: #9ca3af; line-height: 1; }
                .modal-body { padding: 30px 20px; }
                .input-group { display: flex; gap: 10px; justify-content: center; margin-bottom: 20px; }
                .input-group input { width: 80px; padding: 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 18px; text-align: center; }
                .btn-yellow { background: #fbbf24; color: #fff; border: none; padding: 12px 20px; border-radius: 4px; font-weight: bold; font-size: 14px; cursor: pointer; flex: 1; }

                /* ========================================= */
                /* AJUSTES PARA TELEMÓVEL (RESPONSIVIDADE)   */
                /* ========================================= */
                @media (max-width: 768px) {
                    body { flex-direction: column; overflow: visible; }
                    .sidebar { width: 100%; padding: 15px 0 0 0; border-right: none; border-bottom: 1px solid var(--border); }
                    .logo { text-align: center; border-bottom: none; padding-bottom: 10px; }
                    .menu-container { margin-top: 0; display: flex; overflow-x: auto; white-space: nowrap; padding: 0 10px; -webkit-overflow-scrolling: touch; }
                    .menu-item { padding: 12px 15px; border-left: none; border-bottom: 3px solid transparent; font-size: 14px; }
                    .menu-item.active { border-left-color: transparent; border-bottom-color: var(--blue); }
                    .main { padding: 15px; overflow-y: visible; }
                    .grid-top { grid-template-columns: 1fr; gap: 15px; }
                    .grid-maquinas { grid-template-columns: 1fr; gap: 15px; }
                    .card { padding: 20px; }
                    .chart-container { height: 250px; }
                }
            </style>
        </head>
        <body>
            <aside class="sidebar">
                <div class="logo">Gruas<span>Gravatá</span></div>
                <div class="menu-container">
                    <a class="menu-item ${abaAtiva === 'view-dashboard' ? 'active' : ''}" onclick="mudarAba('view-dashboard', this)">📊 Dashboard</a>
                    <a class="menu-item ${abaAtiva === 'view-maquinas' ? 'active' : ''}" onclick="mudarAba('view-maquinas', this)">🕹️ Minhas Máquinas</a>
                </div>
            </aside>

            <main class="main">
                ${alertMsg ? '<div style="background: #def7ec; color: #03543f; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #bcdecb;">' + alertMsg + '</div>' : ''}

                <div id="view-dashboard" class="view-section ${abaAtiva === 'view-dashboard' ? 'active' : ''}">
                    <div class="grid-top">
                        <div class="card">
                            <h2>Total Diário <span style="font-weight: normal; color: #6b7280; font-size: 14px;">(Rede)</span></h2>
                            <h1 id="faturamento-hoje" style="font-size: 32px; margin: 10px 0; color: var(--blue);">R$ 0,00</h1>
                            <p style="color: var(--text-muted); font-size: 14px;">Máquinas Online: <span id="maquinas-online-count" style="font-weight: bold; color: #03543f;">0</span></p>
                        </div>
                        <div class="card">
                            <h2>Faturamento <span style="font-weight: normal; color: #6b7280; font-size: 14px;">Últimos 7 dias</span></h2>
                            <div class="chart-container"><canvas id="graficoFaturamento"></canvas></div>
                        </div>
                    </div>
                </div>

                <div id="view-maquinas" class="view-section ${abaAtiva === 'view-maquinas' ? 'active' : ''}">
                    <h2 style="font-size: 20px;">Controle de Máquinas</h2>
                    <p style="color: var(--text-muted); margin-bottom: 20px; font-size: 14px;">Gerencie suas gruas cadastradas.</p>
                    
                    <div class="grid-maquinas" id="container-maquinas">
                        <div style="text-align: center; color: #9ca3af; width: 100%; padding: 20px;">Aguardando dados da nuvem...</div>
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
                        <h3 id="modal-maquina-titulo" style="margin-top:0;">Incluir Crédito</h3>
                        <input type="hidden" id="modal-maquina-id">
                        <div class="input-group">
                            <input type="number" id="qtdPulsos" value="1" min="1">
                            <button class="btn-yellow" onclick="enviarCredito()" id="btn-enviar-modal">ENVIAR</button>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                function mudarAba(idAba, el) {
                    document.querySelectorAll('.view-section').forEach(e => e.classList.remove('active'));
                    document.querySelectorAll('.menu-item').forEach(e => e.classList.remove('active'));
                    document.getElementById(idAba).classList.add('active');
                    el.classList.add('active');
                }

                function abrirModal(idMaquina) { 
                    document.getElementById('modal-maquina-id').value = idMaquina;
                    document.getElementById('modal-maquina-titulo').innerText = 'Crédito para ' + idMaquina;
                    document.getElementById('modalCredito').style.display = 'flex'; 
                }
                function fecharModal() { document.getElementById('modalCredito').style.display = 'none'; }
                
                function enviarCredito() {
                    const btn = document.getElementById('btn-enviar-modal');
                    const idMaquina = document.getElementById('modal-maquina-id').value;
                    const qtd = document.getElementById('qtdPulsos').value;
                    btn.innerText = 'ENVIANDO...';
                    
                    fetch('/webhook-manual?maquina=' + idMaquina + '&pulsos=' + qtd)
                    .then(() => {
                        btn.innerText = 'SUCESSO!'; btn.style.background = '#10b981'; 
                        setTimeout(() => { fecharModal(); btn.innerText = 'ENVIAR'; btn.style.background = '#fbbf24'; }, 1500);
                    });
                }

                const firebaseConfig = { databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com" };
                firebase.initializeApp(firebaseConfig);
                const db = firebase.database();

                const ctx = document.getElementById('graficoFaturamento').getContext('2d');
                let grafico = new Chart(ctx, { type: 'bar', data: { labels: [], datasets: [{ label: 'Faturamento (R$)', data: [], backgroundColor: '#93c5fd' }] }, options: { responsive: true, maintainAspectRatio: false }});

                db.ref('/Vending-Machines').on('value', snap => {
                    const container = document.getElementById('container-maquinas');
                    container.innerHTML = ''; 
                    
                    let faturamentoGlobalHoje = 0;
                    let qtdMaquinasOnline = 0;
                    const vendasGlobalPorDia = {};
                    const hojeStr = new Date().toLocaleDateString('pt-BR');

                    snap.forEach(maquinaSnap => {
                        const idDaMaquina = maquinaSnap.key; 
                        const dados = maquinaSnap.val();
                        
                        let statusHtml = '<span class="status-offline">OFFLINE</span>';
                        let textoPing = '--:--';
                        if (dados.ultimo_ping) {
                            const diffSegundos = (Date.now() - dados.ultimo_ping) / 1000;
                            textoPing = new Date(dados.ultimo_ping).toLocaleTimeString('pt-BR');
                            if (diffSegundos < 120) {
                                statusHtml = '<span class="status-online">ONLINE</span>';
                                qtdMaquinasOnline++;
                            }
                        }

                        if (dados.historico_vendas) {
                            Object.values(dados.historico_vendas).forEach(venda => {
                                const dataVenda = new Date(venda.data);
                                const dataStr = dataVenda.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                                
                                if(!vendasGlobalPorDia[dataStr]) vendasGlobalPorDia[dataStr] = 0;
                                vendasGlobalPorDia[dataStr] += venda.valor;

                                if (dataVenda.toLocaleDateString('pt-BR') === hojeStr) {
                                    faturamentoGlobalHoje += venda.valor;
                                }
                            });
                        }

                        const pulso = dados.configuracoes?.tempo_pulso_ms || 100;
                        const pausa = dados.configuracoes?.tempo_pausa_ms || 400;

                        // AQUI CONTINUA COM A BARRA INVERTIDA PORQUE RODA NO NAVEGADOR
                        const cardHtml = \`
                            <div class="card" style="margin-bottom: 0;">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                                    <div>
                                        <h3 style="margin: 0; font-size: 16px; color: #111827;">🕹️ \${idDaMaquina}</h3>
                                    </div>
                                    \${statusHtml}
                                </div>
                                <p style="color: var(--text-muted); font-size: 12px; margin: 0;">Último ping: \${textoPing}</p>
                                <hr>
                                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                                    <button onclick="abrirModal('\${idDaMaquina}')" style="flex: 1; padding: 10px; background: #fff; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-weight: bold; color: #374151; font-size: 12px;">🎟️ Crédito</button>
                                    <form action="/reiniciar-maquina" method="POST" style="flex: 1; margin: 0;">
                                        <input type="hidden" name="maquina" value="\${idDaMaquina}">
                                        <button type="submit" onclick="return confirm('Reiniciar \${idDaMaquina}?');" style="width: 100%; padding: 10px; background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px;">🔄 Reiniciar</button>
                                    </form>
                                </div>
                                <h4 style="margin: 0 0 10px 0; color: #374151; font-size: 13px;">⚙️ Relé</h4>
                                <form action="/salvar-config" method="POST">
                                    <input type="hidden" name="maquina" value="\${idDaMaquina}">
                                    <div style="display: flex; gap: 10px;">
                                        <div style="flex:1;"><label style="font-size:10px;">Pulso (ms)</label><input type="number" name="pulso" class="form-input" value="\${pulso}"></div>
                                        <div style="flex:1;"><label style="font-size:10px;">Pausa (ms)</label><input type="number" name="pausa" class="form-input" value="\${pausa}"></div>
                                    </div>
                                    <button type="submit" class="btn-primary" style="padding: 8px; font-size: 12px;">💾 Salvar</button>
                                </form>
                            </div>
                        \`;
                        container.innerHTML += cardHtml;
                    });

                    document.getElementById('faturamento-hoje').innerText = 'R$ ' + faturamentoGlobalHoje.toLocaleString('pt-BR', {minimumFractionDigits: 2});
                    document.getElementById('maquinas-online-count').innerText = qtdMaquinasOnline;
                    
                    grafico.data.labels = Object.keys(vendasGlobalPorDia).slice(-7); 
                    grafico.data.datasets[0].data = Object.values(vendasGlobalPorDia).slice(-7);
                    grafico.update();
                });
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online com a Dashboard Responsiva pronta a rolar!"));
