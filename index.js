const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Necessário para ler o formulário das configurações

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
        console.log(`✅ ${pulsos} pulsos para ${maquinaID}. A aguardar máquina...`);

        setTimeout(async () => {
            const snapshot = await ref.child("jogadas_pendentes").once("value");
            const pendentes = snapshot.val();
            if (pendentes > 0) {
                await ref.update({ "jogadas_pendentes": 0 });
                console.log(`❌ TIMEOUT: ${maquinaID} offline. Crédito expirado.`);
            }
        }, 60000); 
    } catch (error) {
        console.error("Erro ao libertar crédito:", error.message);
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

// NOVA ROTA: GUARDAR CONFIGURAÇÕES NA NUVEM
app.post('/salvar-config', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    const pulso = parseInt(req.body.pulso) || 100;
    const pausa = parseInt(req.body.pausa) || 400;

    try {
        await db.ref(`Vending-Machines/${maquina}/configuracoes`).update({
            "tempo_pulso_ms": pulso,
            "tempo_pausa_ms": pausa
        });
        // Redireciona de volta para o painel após guardar
        res.redirect('/painel?status=sucesso');
    } catch (error) {
        res.status(500).send("Erro ao guardar definições.");
    }
});

// PAINEL PROFISSIONAL COM CONFIGURAÇÕES
app.get('/painel', async (req, res) => {
    // Tenta ler as configurações atuais da nuvem para mostrar no painel
    let pulsoAtual = 100;
    let pausaAtual = 400;
    try {
        const snap = await db.ref('Vending-Machines/Maquina-01/configuracoes').once('value');
        if(snap.exists()){
            pulsoAtual = snap.val().tempo_pulso_ms || 100;
            pausaAtual = snap.val().tempo_pausa_ms || 400;
        }
    } catch(e) {}

    const mensagem = req.query.status === 'sucesso' ? '<p style="color:green; font-weight:bold;">✅ Definições guardadas na Nuvem!</p>' : '';

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
                <h3>⚙️ Afinação Remota (Maquina-01)</h3>
                <form action="/salvar-config" method="POST" style="text-align: left; padding: 10px;">
                    <input type="hidden" name="maquina" value="Maquina-01">
                    
                    <label>Tempo do Relé Ativado (ms):</label><br>
                    <input type="number" name="pulso" value="${pulsoAtual}" style="width: 100%; padding: 10px; margin-bottom: 15px;"><br>
                    
                    <label>Tempo de Pausa (ms):</label><br>
                    <input type="number" name="pausa" value="${pausaAtual}" style="width: 100%; padding: 10px; margin-bottom: 15px;"><br>
                    
                    <button type="submit" style="background:#007bff; color:white; padding:10px 20px; width: 100%; font-size: 16px; cursor:pointer; border:none; border-radius: 5px;">Salvar na Nuvem</button>
                </form>
                <p style="font-size: 12px; color: #666;">*A máquina irá ler estes valores automaticamente antes da próxima jogada.</p>
            </div>
        </div>
        <script>
            function liberar(id, qtd) {
                document.getElementById('msg').innerText = 'A processar...';
                fetch('/webhook-manual?maquina=' + id + '&pulsos=' + qtd)
                .then(() => document.getElementById('msg').innerText = '✅ Crédito enviado para ' + id);
            }
        </script>
    `);
});

app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    const qtd = parseInt(req.query.pulsos) || 2;
    liberarCredito(maquina, qtd);
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online!"));
