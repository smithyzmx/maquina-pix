const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Inicializa o Firebase com a chave que você baixou
const serviceAccount = require("./firebase-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/" // TROQUE PELO SEU LINK
});

const db = admin.database();

app.post('/webhook', async (req, res) => {
    const paymentId = req.body.data?.id;

    if (paymentId) {
        try {
            // Consulta o Mercado Pago (O Token vai ficar escondido no Heroku)
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });

            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                const pulsos = Math.floor(valor / 2); // Sua regra de 2 reais
                
                // Manda para o Firebase
                await db.ref('maquina1/credito').set(pulsos);
                console.log(`Sucesso! ${pulsos} pulsos enviados.`);
            }
        } catch (error) {
            console.error("Erro ao consultar MP:", error.message);
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

// Uma página simples para você acessar do celular
app.get('/painel-controle', (req, res) => {
    res.send(`
        <h1>Painel da Máquina</h1>
        <button onclick="liberar()">Liberar 1 Crédito (Máquina 1)</button>
        <script>
            function liberar() {
                fetch('/webhook-manual', { method: 'POST' })
                .alert('Comando enviado!');
            }
        </script>
    `);
});

// Esta rota agora aceita o clique do botão (POST) e o link do navegador (GET)
app.all('/webhook-manual', async (req, res) => {
    console.log("Recebi um comando manual! Tentando falar com o Firebase...");
    try {
        await db.ref('maquina1/credito').set(1);
        console.log("✅ Sucesso! O valor 1 foi escrito no Firebase.");
        res.send("<h1>Sucesso!</h1><p>O crédito foi enviado para o Firebase.</p>");
    } catch (error) {
        console.error("❌ Erro ao escrever no Firebase:", error.message);
        res.status(500).send("Erro ao acessar o Firebase: " + error.message);
    }
});

