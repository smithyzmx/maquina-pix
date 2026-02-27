const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(express.json());

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

// WEBHOOK AUTOMÁTICO DO MERCADO PAGO
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
                
                // AQUI ESTÁ O SEGREDO: O ID que defines no QR Code
                const maquinaID = response.data.external_reference || "Maquina-01";
                
                await db.ref(`Vending-Machines/${maquinaID}`).update({
                    "jogadas_pendentes": pulsos,
                    "ultima_venda": new Date().toLocaleString("pt-BR", {timeZone: "America/Recife"})
                });
                
                console.log(`✅ Sucesso: ${pulsos} pulsos para ${maquinaID}`);
            }
        } catch (error) {
            console.error("❌ Erro no processamento do MP:", error.message);
        }
    }
    res.sendStatus(200);
});

// PAINEL COM SELEÇÃO DE MÁQUINA
app.get('/painel', (req, res) => {
    res.send(`
        <div style="text-align:center; font-family:sans-serif; padding:20px;">
            <h1>🕹️ Painel de Controle - Gravatá</h1>
            <div style="margin-bottom:20px; border:1px solid #ccc; padding:15px; border-radius:10px;">
                <h3>Máquina 01 (Posto)</h3>
                <button onclick="liberar('Maquina-01', 2)" style="background:green; color:white; padding:10px;">Liberar R$ 2</button>
            </div>
            <div style="margin-bottom:20px; border:1px solid #ccc; padding:15px; border-radius:10px;">
                <h3>Máquina 02 (Shopping)</h3>
                <button onclick="liberar('Maquina-02', 2)" style="background:blue; color:white; padding:10px;">Liberar R$ 2</button>
            </div>
            <h2 id="msg"></h2>
        </div>
        <script>
            function liberar(id, qtd) {
                document.getElementById('msg').innerText = 'Enviando...';
                fetch('/webhook-manual?maquina=' + id + '&pulsos=' + qtd)
                .then(() => document.getElementById('msg').innerText = '✅ Enviado para ' + id);
            }
        </script>
    `);
});

// ROTA MANUAL DINÂMICA
app.all('/webhook-manual', async (req, res) => {
    const maquina = req.query.maquina || "Maquina-01";
    const qtd = parseInt(req.query.pulsos) || 2;
    try {
        await db.ref(`Vending-Machines/${maquina}`).update({ "jogadas_pendentes": qtd });
        res.send("OK");
    } catch (e) { res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online!"));
