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

// ⏳ FUNÇÃO DE CRÉDITO COM VALIDADE (60 SEGUNDOS)
async function liberarCredito(maquinaID, pulsos) {
    const ref = db.ref(`Vending-Machines/${maquinaID}`);
    try {
        await ref.update({
            "jogadas_pendentes": pulsos,
            "ultima_venda": new Date().toLocaleString("pt-BR", {timeZone: "America/Recife"})
        });
        console.log(`✅ ${pulsos} pulsos para ${maquinaID}. Aguardando máquina...`);

        setTimeout(async () => {
            const snapshot = await ref.child("jogadas_pendentes").once("value");
            const pendentes = snapshot.val();
            if (pendentes > 0) {
                await ref.update({ "jogadas_pendentes": 0 });
                console.log(`❌ TIMEOUT: ${maquinaID} offline. Crédito expirado.`);
            }
        }, 60000); 
    } catch (error) {
        console.error("Erro ao liberar crédito:", error.message);
    }
}

// WEBHOOK DO MERCADO PAGO
app.post('/webhook', async (req, res) => {
    const paymentId = req.body.data?.id || (req.body.resource ? req.body.resource.split('/').pop() : null);
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
            }
        } catch (error) {}
    }
    res.sendStatus(200);
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

// NOVA ROTA: ENVIAR COMANDO DE REINICIAR
app.post('/reiniciar-maquina', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}`).update({
        "comando": "REINICIAR"
    });
    res.redirect('/painel?status=reiniciando');
});

// PAINEL PROFISSIONAL
app.get('/painel', async (req, res) => {
    let pulsoAtual = 100, pausaAtual = 400;
    try {
        const snap = await db.ref('Vending-Machines/Maquina-01/configuracoes').once('value');
        if(snap.exists()){
            pulsoAtual = snap.val().tempo_pulso_ms || 100;
            pausaAtual = snap.val().tempo_pausa_ms || 400;
        }
    } catch(e) {}

    const mensagem = req.query.status === 'sucesso' ? '<p style="color:green; font-weight:bold;">✅ Configurações salvas!</p>' : 
                     req.query.status === 'reiniciando' ? '<p style="color:orange; font-weight:bold;">🔄 Comando de reinício enviado para a máquina!</p>' : '';

    res.send(`
        <div style="text-align:center; font-family:sans-serif; padding:20px; max-width: 600px; margin: auto;">
            <h1>🕹️ Painel Cloud - Máquinas</h1>
            ${mensagem}
            
            <div style="margin-bottom:20px; border:2px solid #28a745; padding:15px; border-radius:10px; background-color: #f8f9fa;">
                <h3>💳 Testar Pagamento (Maquina-01)</h3>
                <button onclick="liberar('Maquina-01', 2)" style="background:#28a745; color:white; padding:15px 30px; font-size: 16px; cursor:pointer; border:none; border-radius: 5px;">Simular PIX de R$ 2</button>
                <p id="msg"></p>
            </div>

            <div style="margin-bottom:20px; border:2px solid #007bff; padding:15px; border-radius:10px; background-color: #f8f9fa;">
                <h3>⚙️ Configuração Remota (Maquina-01)</h3>
                <form action="/salvar-config" method="POST" style="text-align: left; padding: 10px;">
                    <input type="hidden" name="maquina" value="Maquina-01">
                    <label>Tempo do Relé Ativado (ms):</label><br>
                    <input type="number" name="pulso" value="${pulsoAtual}" style="width: 100%; padding: 10px; margin-bottom: 15px;"><br>
                    <label>Tempo de Pausa (ms):</label><br>
                    <input type="number" name="pausa" value="${pausaAtual}" style="width: 100%; padding: 10px; margin-bottom: 15px;"><br>
                    <button type="submit" style="background:#007bff; color:white; padding:10px 20px; width: 100%; font-size: 16px; cursor:pointer; border:none; border-radius: 5px;">Salvar na Nuvem</button>
                </form>
            </div>

            <div style="margin-bottom:20px; border:2px solid #dc3545; padding:15px; border-radius:10px; background-color: #f8f9fa;">
                <h3>⚠️ Ações de Emergência (Maquina-01)</h3>
                <form action="/reiniciar-maquina" method="POST">
                    <input type="hidden" name="maquina" value="Maquina-01">
                    <button type="submit" onclick="return confirm('Tem certeza que deseja reiniciar a máquina à distância? A placa será desligada e ligada novamente.');" style="background:#dc3545; color:white; padding:15px 20px; width: 100%; font-size: 16px; cursor:pointer; border:none; border-radius: 5px;">🔄 Reiniciar Arduino/ESP8266</button>
                </form>
            </div>
        </div>
        <script>
            function liberar(id, qtd) {
                document.getElementById('msg').innerText = 'Enviando...';
                fetch('/webhook-manual?maquina=' + id + '&pulsos=' + qtd)
                .then(() => document.getElementById('msg').innerText = '✅ Crédito enviado para ' + id);
            }
        </script>
    `);
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    liberarCredito(maquina, parseInt(req.query.pulsos) || 2);
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online!"));
