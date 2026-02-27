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

// Rota interna para o botão funcionar
app.post('/webhook-manual', async (req, res) => {
    await db.ref('maquina1/credito').set(1);
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
