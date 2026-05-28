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
                
                const refExterna = response.data.external_reference || "";
                const descricao = response.data.description || "";
                const titulo = response.data.title || "";
                const posId = String(response.data.pos_id || "");

                const extrairGrua = (texto) => {
                    const regex = /GRUA-[A-Z0-9]{4}/i;
                    const match = String(texto).match(regex);
                    return match ? match[0].toUpperCase() : null;
                };
                const gruaEncontrada = extrairGrua(refExterna) || extrairGrua(descricao) || extrairGrua(titulo);

                let maquinaID = "Maquina-01"; 

                if (posId) {
                    const vinculoSnap = await db.ref(`Vinculos-Caixas/${posId}`).once('value');
                    if (vinculoSnap.exists()) {
                        maquinaID = vinculoSnap.val();
                    } else if (gruaEncontrada) {
                        maquinaID = gruaEncontrada; 
                    }
                } else if (gruaEncontrada) {
                    maquinaID = gruaEncontrada; 
                }

                const dataPagamento = new Date(response.data.date_approved);
                const dataAgora = new Date();
                const diferencaEmMinutos = (dataAgora - dataPagamento) / (1000 * 60);

                if (diferencaEmMinutos > 3) {
                    console.log(`⏳ PIX atrasado. Guardado no histórico, NÃO libertando jogada na ${maquinaID}.`);
                } else {
                    liberarCredito(maquinaID, pulsos);
                }

                db.ref(`Vending-Machines/${maquinaID}/historico_vendas`).push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId,
                    metodo: 'PIX',
                    pos_id_recebido: posId,
                    status_liberacao: diferencaEmMinutos > 3 ? 'Bloqueado (Atraso)' : 'Liberado'
                });
            }
        } catch (error) {
            console.error("Erro no Webhook:", error.message);
        }
    }
});

app.post('/vincular-caixa', async (req, res) => {
    const posId = req.body.pos_id;
    const maquinaId = req.body.maquina_id;
    if(posId && maquinaId) await db.ref(`Vinculos-Caixas/${posId}`).set(maquinaId.toUpperCase());
    res.redirect('/painel?aba=vinculos&status=sucesso');
});

app.post('/desvincular-caixa', async (req, res) => {
    const posId = req.body.pos_id;
    if(posId) await db.ref(`Vinculos-Caixas/${posId}`).remove();
    res.redirect('/painel?aba=vinculos&status=sucesso');
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
    if(maquina) await db.ref(`Vending-Machines/${maquina}`).remove();
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    liberarCredito(maquina, parseInt(req.query.pulsos) || 1);
    res.send("OK");
});

app.get('/painel', (req, res) => {
    let abaAtiva = 'view-dashboard';
    if (req.query.aba === 'maquinas') abaAtiva = 'view-maquinas';
    if (req.query.aba === 'vinculos') abaAtiva = 'view-vinculos';
    
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
                .btn-danger { background: #ef4444; color: white; padding: 8px 15px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
                hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
                .tabela-historico { width: 100%; border-collapse: collapse; font-size: 14px; }
                .tabela-historico th { text-align: left; padding: 12px; border-bottom: 2px solid var(--border); color: var(--text-muted); font-weight: 600; }
                .tabela-historico td { padding: 12px; border-bottom: 1px solid var(--border); }
                .tabela-historico tr:hover { background-color: #f9fafb; }
                .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: center; padding: 15px; box-sizing: border-box; }
                .modal { background: #fff; width: 100%; max-width: 400px; border-radius: 8px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); text-align: center; }
                .modal-header { background: #f3f4f6; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; font-weight: bold; border-bottom: 1px solid var(--border); }
                .close-btn { cursor: pointer; font-size: 24px; color: #9ca3af; line-height: 1; }
                .modal-body { padding: 30px 20px; }
                .input-group { display: flex; gap: 10px; justify-content: center; margin-bottom: 20px; }
                .input-group input { width: 80px; padding: 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 18px; text-align: center; }
                .btn-yellow { background: #fbbf24; color: #fff; border: none; padding: 12px 20px; border-radius: 4px; font-weight: bold; font-size: 14px; cursor: pointer; flex: 1; }
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
                    .tabela-historico-container { overflow-x: auto; }
                }
            </style>
        </head>
        <body>
            <aside class="sidebar">
                <div class="logo">Gruas<span>Gravatá</span></div>
                <div class="menu-container">
                    <a class="menu-item ${abaAtiva === 'view-dashboard' ? 'active' : ''}" onclick="mudarAba('view-dashboard', this)">📊 Dashboard</a>
                    <a class="menu-item ${abaAtiva === 'view-maquinas' ? 'active' : ''}" onclick="mudarAba('view-maquinas', this)">🕹️ Máquinas</a>
                    <a class="menu-item ${abaAtiva === 'view-vinculos' ? 'active' : ''}" onclick="mudarAba('view-vinculos', this)">🔗 Vincular QR</a>
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
                    
                    <div class="card tabela-historico-container">
                        <h2>💰 Últimos Pagamentos Recebidos</h2>
                        <table class="tabela-historico">
                            <thead>
                                <tr>
                                    <th>Data</th>
                                    <th>Máquina</th>
                                    <th>Valor</th>
                                    <th>POS Caixa</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody id="lista-pagamentos">
                                <tr><td colspan="5" style="text-align:center; color: #9ca3af;">Carregando...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div id="view-maquinas" class="view-section ${abaAtiva === 'view-maquinas' ? 'active' : ''}">
                    <h2 style="font-size: 20px;">Controle de Máquinas</h2>
                    <p style="color: var(--text-muted); margin-bottom: 20px; font-size: 14px;">Gere a placa, relé, Wi-Fi e comandos.</p>
                    <div class="grid-maquinas" id="container-maquinas">
                        <div style="text-align: center; color: #9ca3af; width: 100%; padding: 20px;">Aguardando dados...</div>
                    </div>
                </div>

                <div id="view-vinculos" class="view-section ${abaAtiva === 'view-vinculos' ? 'active' : ''}">
                    <h2 style="font-size: 20px;">Vincular Caixas do Mercado Pago</h2>
                    <p style="color: var(--text-muted); margin-bottom: 20px; font-size: 14px;">Ensine ao sistema a qual grua pertence cada QR Code.</p>
                    
                    <div class="card" style="max-width: 600px; margin-bottom: 30px;">
                        <h3 style="margin-top:0; font-size: 16px;">Criar Novo Vínculo</h3>
                        <form action="/vincular-caixa" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <div style="flex: 1; min-width: 150px;"><label>Nº do Caixa (POS ID)</label><input type="text" name="pos_id" class="form-input" required></div>
                            <div style="flex: 1; min-width: 150px;"><label>Nome da Máquina</label><input type="text" name="maquina_id" class="form-input" required></div>
                            <div style="width: 100%; margin-top: 5px;"><button type="submit" class="btn-primary">Vincular QR Code</button></div>
                        </form>
                    </div>

                    <div class="card tabela-historico-container">
                        <h2>🔗 Ligações Ativas</h2>
                        <table class="tabela-historico">
                            <thead><tr><th>Nº do Caixa</th><th>Máquina Destino</th><th>Ação</th></tr></thead>
                            <tbody id="lista-vinculos"><tr><td colspan="3" style="text-align:center;">Aguardando...</td></tr></tbody>
                        </table>
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
                    let todasAsVendas = [];

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
                                todasAsVendas.push({ maquina: idDaMaquina, ...venda });
                                const dataVenda = new Date(venda.data);
                                const dataStr = dataVenda.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                                if(!vendasGlobalPorDia[dataStr]) vendasGlobalPorDia[dataStr] = 0;
                                vendasGlobalPorDia[dataStr] += venda.valor;
                                if (dataVenda.toLocaleDateString('pt-BR') === hojeStr) faturamentoGlobalHoje += venda.valor;
                            });
                        }

                        const pulso = dados.configuracoes?.tempo_pulso_ms || 100;
                        const pausa = dados.configuracoes?.tempo_pausa_ms || 400;

                        // === LÓGICA DE WI-FI DO CARTÃO ===
                        const rede = dados.rede || {};
                        let ssid = rede.ssid || 'Desconhecido';
                        const rssi = rede.rssi || -100;

                        let sinalIcon = '📶';
                        let sinalCor = '#9ca3af';
                        let sinalTexto = 'Sem Sinal';

                        if (statusHtml.includes('ONLINE')) {
                            if (rssi > -60) { sinalCor = '#10b981'; sinalTexto = 'Excelente'; } 
                            else if (rssi > -75) { sinalCor = '#fbbf24'; sinalTexto = 'Bom'; } 
                            else if (rssi > -85) { sinalCor = '#f97316'; sinalTexto = 'Fraco'; } 
                            else { sinalCor = '#ef4444'; sinalTexto = 'Péssimo'; } 
                        } else {
                            sinalIcon = '📵';
                            sinalTexto = 'Offline';
                            ssid = '---';
                        }

                        const cardHtml = \`
                            <div class="card" style="margin-bottom: 0;">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                                    <div><h3 style="margin: 0; font-size: 16px; color: #111827;">🕹️ \${idDaMaquina}</h3></div>
                                    <div style="display: flex; gap: 10px; align-items: center;">
                                        \${statusHtml}
                                        <form action="/deletar-maquina" method="POST" style="margin: 0;">
                                            <input type="hidden" name="maquina" value="\${idDaMaquina}">
                                            <button type="submit" onclick="return confirm('Tem certeza?');" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 16px;">🗑️</button>
                                        </form>
                                    </div>
                                </div>
                                <p style="color: var(--text-muted); font-size: 12px; margin: 0;">Último ping: \${textoPing}</p>
                                
                                <div style="background: #f9fafb; padding: 10px; border-radius: 6px; margin: 12px 0; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border);">
                                    <div>
                                        <div style="font-size: 10px; font-weight: bold; color: var(--text-muted); text-transform: uppercase;">Wi-Fi Conectado</div>
                                        <div style="font-size: 13px; font-weight: 600; color: #111827; margin-top: 2px;">\${ssid}</div>
                                    </div>
                                    <div style="text-align: right;">
                                        <div style="font-size: 10px; font-weight: bold; color: var(--text-muted); text-transform: uppercase;">Força do Sinal</div>
                                        <div style="font-size: 12px; font-weight: bold; color: \${sinalCor}; margin-top: 2px;">\${sinalIcon} \${sinalTexto}</div>
                                    </div>
                                </div>

                                <hr style="margin: 15px 0;">
                                <div style="display: flex; gap: 10px; margin-bottom: 15px;">
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
                                        <div style="flex:1;"><label style="font-size:10px;">Pulso</label><input type="number" name="pulso" class="form-input" value="\${pulso}"></div>
                                        <div style="flex:1;"><label style="font-size:10px;">Pausa</label><input type="number" name="pausa" class="form-input" value="\${pausa}"></div>
                                    </div>
                                    <button type="submit" class="btn-primary" style="padding: 8px; font-size: 12px;">💾 Salvar</button>
                                </form>
                            </div>
                        \`;
                        container.innerHTML += cardHtml;
                    });

                    todasAsVendas.sort((a, b) => b.data - a.data);
                    const ultimasVendas = todasAsVendas.slice(0, 15);
                    const tbody = document.getElementById('lista-pagamentos');
                    tbody.innerHTML = ''; 
                    if (ultimasVendas.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: #9ca3af;">Sem pagamentos.</td></tr>';
                    } else {
                        ultimasVendas.forEach(v => {
                            const dataFormatada = new Date(v.data).toLocaleString('pt-BR');
                            const valorFormatado = 'R$ ' + v.valor.toLocaleString('pt-BR', {minimumFractionDigits: 2});
                            const posAviso = v.pos_id_recebido ? v.pos_id_recebido : '---';
                            tbody.innerHTML += \`
                                <tr>
                                    <td>\${dataFormatada}</td>
                                    <td style="font-weight: bold;">\${v.maquina}</td>
                                    <td style="color: #047857; font-weight: bold;">\${valorFormatado}</td>
                                    <td style="color: #6b7280; font-size: 12px;">\${posAviso}</td>
                                    <td style="color: #10b981; font-size: 12px;">\${v.status_liberacao || 'Liberado'}</td>
                                </tr>
                            \`;
                        });
                    }
                    document.getElementById('faturamento-hoje').innerText = 'R$ ' + faturamentoGlobalHoje.toLocaleString('pt-BR', {minimumFractionDigits: 2});
                    document.getElementById('maquinas-online-count').innerText = qtdMaquinasOnline;
                    grafico.data.labels = Object.keys(vendasGlobalPorDia).slice(-7); 
                    grafico.data.datasets[0].data = Object.values(vendasGlobalPorDia).slice(-7);
                    grafico.update();
                });

                db.ref('/Vinculos-Caixas').on('value', snap => {
                    const tbodyVinculos = document.getElementById('lista-vinculos');
                    tbodyVinculos.innerHTML = '';
                    if (!snap.exists()) {
                        tbodyVinculos.innerHTML = '<tr><td colspan="3" style="text-align:center; color: #9ca3af;">Nenhum vínculo registado.</td></tr>';
                    } else {
                        snap.forEach(vinculo => {
                            tbodyVinculos.innerHTML += \`
                                <tr>
                                    <td style="font-weight: bold; color: #111827;">\${vinculo.key}</td>
                                    <td style="font-weight: bold; color: var(--blue);">\${vinculo.val()}</td>
                                    <td>
                                        <form action="/desvincular-caixa" method="POST" style="margin: 0;">
                                            <input type="hidden" name="pos_id" value="\${vinculo.key}">
                                            <button type="submit" class="btn-danger" onclick="return confirm('Desvincular o Caixa \${vinculo.key}?');">Desvincular</button>
                                        </form>
                                    </td>
                                </tr>
                            \`;
                        });
                    }
                });
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online com Monitor de Sinal Wi-Fi!"));
