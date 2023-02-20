const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const {init: initDB, Counter} = require("./db");

const logger = morgan("tiny");
const request = require('request')

const app = express();
app.use(express.urlencoded({extended: false}));
app.use(express.json());
app.use(cors());
app.use(logger);

// 首页
app.get("/", async (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
app.post("/api/count", async (req, res) => {
    const {action} = req.body;
    if (action === "inc") {
        await Counter.create();
    } else if (action === "clear") {
        await Counter.destroy({
            truncate: true,
        });
    }
    res.send({
        code: 0,
        data: await Counter.count(),
    });
});

function sendmess(appid, mess) {
    return new Promise((resolve, reject) => {
        request({
            method: 'POST',
            url: `http://api.weixin.qq.com/cgi-bin/message/custom/send?from_appid=${appid}`,
            body: JSON.stringify(mess)
        }, function (error, response) {
            if (error) {
                console.log('接口返回错误', error)
                reject(error.toString())
            } else {
                console.log('接口返回内容', response.body)
                resolve(response.body)
            }
        })
    })
}

app.post("/message/simple", async (req, res) => {
    console.log('消息推送', req.body)
    // 从 header 中取appid，如果 from-appid 不存在，则不是资源复用场景，可以直接传空字符串，使用环境所属账号发起云调用
    const appid = req.headers['x-wx-from-appid'] || ''
    const {ToUserName, FromUserName, MsgType, Content, CreateTime} = req.body
    console.log('推送接收的账号', ToUserName, '创建时间', CreateTime)
    if (MsgType === 'text') {
        if (Content === '回复文字') { // 小程序、公众号可用
            await sendmess(appid, {
                touser: FromUserName,
                msgtype: 'text',
                text: {
                    content: '这是回复的消息'
                }
            })
        }
        res.send('success')
    } else {
        res.send('success')
    }
})

// 获取计数
app.get("/api/count", async (req, res) => {
    const result = await Counter.count();
    res.send({
        code: 0,
        data: result,
    });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
    if (req.headers["x-wx-source"]) {
        res.send(req.headers["x-wx-openid"]);
    }
});

const port = process.env.PORT || 80;

async function bootstrap() {
    await initDB();
    app.listen(port, () => {
        console.log("启动成功", port);
    });
}

bootstrap();
