const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// 1. Inicialização do Firebase
try {
    const serviceAccount = require("./firebase-key.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/" 
    });
    console.log("Conectado ao Firebase com sucesso!");
} catch (error) {
    console.error("Erro crítico na inicialização do Firebase:", error.message);
}

const db = admin.database();

// 2. Webhook oficial do Mercado Pago
app.post('/webhook', async (req, res) => {
    const paymentId = req.body.data?.id || (req.body.resource ? req.body.resource.split('/').pop() : null);

    if (paymentId) {
        try {
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });

            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                const pulsos = Math.floor(valor / 2); // Regra: R$ 2,00 = 1 pulso
                
                await db.ref('maquina1/credito').set(pulsos);
                console.log(`✅ PIX Aprovado: ${valor} reais -> ${pulsos} pulsos enviados.`);
            }
        } catch (error) {
            console.error("❌ Erro ao consultar Mercado Pago:", error.message);
        }
    }
    res.sendStatus(200);
});

// 3. Painel de Controle Visual
app.get('/painel', (req, res) => {
    res.send(`
        <div style="text-align:center; font-family:sans-serif; margin-top:50px; background:#f4f4f4; padding:20px;">
            <h1>🕹️ Painel de Controle - Gravatá</h1>
            <p>Toque no botão abaixo para testar a máquina.</p>
            <button onclick="liberar()" style="padding:25px 50px; font-size:2
