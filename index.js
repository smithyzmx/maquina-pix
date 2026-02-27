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
    console.error("Erro na inicialização:", error.message);
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
                
                // AJUSTE: Se o valor for R$ 2, mandamos o número 2 para o Firebase
                // O ESP8266 vai ler "2" e dar os 2 pulsos que a placa precisa
                const pulsos = Math.floor(valor); 
                
                await db.ref('maquina1/credito').set(pulsos);
                console.log(`✅ PIX Aprovado: R$ ${valor} -> Enviando ${pulsos} para o Firebase.`);
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
            <p>Configuração: R$ 2,00 = 2 Pulsos</p>
            <button onclick="liberar(2)" style="padding:25px 50px; font-size:22px; background:#28a745; color:white; border:none; border-radius:15px; cursor:pointer; box-shadow: 0 4px #1e7e34;">
                LIBERAR 2 PULSOS (R$ 2)
            </button>
            <br><br>
            <button onclick="liberar(10)" style="padding:15px 30px; font-size:16px; background:#007bff; color:white; border:none; border-radius:10px; cursor:pointer;">
                LIBERAR 10 PULSOS (R$ 10)
            </button>
            <h2 id="msg" style="margin-top:30px;"></h2>
        </div>
        <script>
            function liberar(qtd) {
                const msg = document.getElementById('msg');
                msg.innerText = 'Enviando ' + qtd + ' pulsos...';
                fetch(window.location.origin + '/webhook-manual?pulsos=' + qtd, { method: 'POST' })
                .then(res => {
                    if(res.ok) msg.innerText = '✅ ' + qtd + ' PULSOS ENVIADOS!';
                    else msg.innerText = '❌ Erro no Servidor';
                })
                .catch(err => msg.innerText = '❌ Erro de Conexão');
            }
        </script>
    `);
});

// 4. Rota de Comando (Aceita GET e POST)
app.all('/webhook-manual', async (req, res) => {
    // Pega a quantidade de pulsos da URL ou usa 2 como padrão
    const qtdPulsos = parseInt(req.query.pulsos) || 2;
    
    console.log("Comando manual: " + qtdPulsos + " pulsos.");
    try {
        await db.ref('maquina1/credito').set(qtdPulsos);
        res.send("<h1>Sucesso!</h1><p>Enviado " + qtdPulsos + " para o Firebase.</p>");
    } catch (error) {
        res
