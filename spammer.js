var iotalib= require('iota.lib.js');
var mysql = null;
var http = require('http');
var config = require('./spammer-config.js');

var job=null;
var con=null;
var iota=null;

// read arguments
for(var i=2;i<process.argv.length;i++){
    if(process.argv[i]==="reattach"){
        console.log(getPrintableTime()+" - Using automated reattach");
        config.general.reattach=true;
    } else if(process.argv[i]==="loop"){
        console.log(getPrintableTime()+" - Running in loop mode");
        config.general.loop=true;
    } else if(process.argv[i].length===81){
        if (config.general.sql){
            console.log("---- FATAL ERROR - Cannot run with task in SQL mode ----");
            process.exit(1);
        }
        console.log(getPrintableTime()+" - Having specific task");
        console.log(getPrintableTime()+" - Transaction to promote:"+process.argv[i]);
        job={hash:process.argv[i]};
    } else if(process.argv[i]==="sql"){
        if (job!==null){
            console.log("---- FATAL ERROR - Cannot run with task in SQL mode ----");
            process.exit(1);
        }
        console.log(getPrintableTime()+" - Running in SQL mode");
        config.general.sql=true;
        var mysql = require('mysql');
    }   
}


function calulateRate(value){
    var tmp=new Date();
    return(Math.ceil(((value*1000000)/(tmp-config.general.start)))/1000);   
}

var connectDB = function () {
     return new Promise((resolve, reject) => {
        if(!config.general.sql) {
            resolve(true);
        } else {
            con = mysql.createConnection({
              host: config.database.host,
              user: config.database.user,
              password: config.database.password,
              database: config.database.database
            });
            con.connect(function(err) {
              if (err) reject(getPrintableTime()+" - Could not establish connection to database.");
              console.log(getPrintableTime()+" - Connection to database established.");
              resolve();
              return;
            });
        }
     });
}

var connectNode = function () {
     return new Promise((resolve, reject) => {
        iota = new iotalib({
            'provider': config.node.schema+'://'+config.node.host+':'+config.node.port
        });
        iota.api.getNodeInfo((err, res) => {
            if (err) reject(getPrintableTime()+" - Could not establish connection to node.");
            console.log(getPrintableTime()+" - Connection to node established.");
            resolve();
            return;
        });
     });
}

var getJob = function () {
    if(config.general.sql) job=null;
    return new Promise((resolve, reject) => {
        if(!config.general.sql) {
            resolve(true);
        } else {
            con.query("SELECT `id`,`hash` FROM `spammer_hashes` WHERE `status`='1' ORDER BY rand() LIMIT 1", function (err, result, fields) {
                if (err) {
                    console.log(getPrintableTime()+" - Error getting job from database");
                    console.log(err);
                    resolve(false);  
                };
                if(result.length!==1){
                    resolve(false);
                    config.general.sleeptime=6*config.general.sleeptimebase;
                } else {
                    config.general.sleeptime=config.general.sleeptimebase;
                  job={id:result[0].id,hash:result[0].hash};
                  console.log(getPrintableTime()+" - Job received:"+result[0].id+ " - current rate "+calulateRate(config.general.promotions)+" p/s - "+calulateRate(config.general.reattaches)+" r/s - "+calulateRate(config.general.promotions+config.general.reattaches)+" a/s");
                  resolve(true); 
                }
            });
        };
    });
}

var sqlJob = function (sql) {
     return new Promise((resolve, reject) => {
        if(!config.general.sql) {
            resolve(true);
        } else {
            con.query(sql, function (err, result) {
              if (err) {
                console.log(getPrintableTime()+" - Error perfoming SQL query:");
                console.log(err);
                resolve(false);  
              };
              resolve(true);
            });
        }
     });
}  

var getPromotable = function(trails){
  // INPUT: array of trail hashes
  // OUTPUT: false or promotable trail hash
  // iterates through all trail-hashes trying to find a promotable one
  // returns promotable hash or false if no promotable hash found
    return new Promise((resolve, reject) => {
        var promises=new Array();
        trails.forEach((tx,index)=>{
            promises.push(
                new Promise((resolve, reject) => {
                    iota.api.isPromotable(tx).then(function (promotable) {
                        if (promotable===true){
                            resolve(true);
                        } else {
                            resolve(false); 
                        }
                    })
                 })
            );
        });
        Promise.all(promises)
        .then(values => {
            values.forEach((promotable,index)=>{
                if(promotable) resolve(trails[index]);
            });
            // not promotable at all
            resolve(false);
        });
    }); 
}

var isConfirmed = function(trails){
  // INPUT: array of trail hashes
  // OUTPUT: true or false
  // Checks all trail hashes if any got confirmed
  // Returns true if any trail hash is confirmed - false if none is confirmed
  return new Promise((resolve, reject) => {
    // check all trail hashes for confirmation
    iota.api.getLatestInclusion(trails, (err, confirmed) => {
        confirmed.forEach((confirmed,index)=>{
           if(confirmed) resolve(true);
        });
        resolve (false);
    });
  }) 
}

var checkBalances = function(bundle){
  // INPUT: bundle data returned from iota.api.findTransactionObjects({bundles:[res[0].bundle]},function(err,bundle){
  // OUTPUT: true = balance ok - false = balance not sufficient - -1 if error occured
  // Inspects the addresses of a bundle and resolves the balances of outgoing addresses
    return new Promise((resolve, reject) => {
        var outGoing={};
        var inGoing={};
        var addresses=new Array();
        bundle.forEach((tx, index) => {
            if(tx.value>=0 && typeof(inGoing[tx.address])==="undefined"){
               inGoing[tx.address]={value:tx.value,transaction:tx.hash,index:tx.currentIndex}; 
            } else if(tx.value<0 && typeof(outGoing[tx.address])==="undefined"){
               outGoing[tx.address]={value:tx.value,transaction:tx.hash,index:tx.currentIndex,balance:-1};  
            }           
        });
        getBalances(outGoing).then(function(balancerequest){
            if(!balancerequest) resolve(-1);
            var valid=true;
            Object.keys(outGoing).forEach(function(address,key){
                if(outGoing[address].balance===-1){
                    resolve(-1);
                } else if(outGoing[address].balance<(outGoing[address].value*-1)){
                   valid=false;
                }
            });
            resolve(valid);
        });  
    });
}

var getBalances = function(addresses){
  // INPUT: link to address object of checkBalance
  // OUTPUT: true = balance resolved - false = error
  // Performing a getBalances query on node for all addresses
    return new Promise((resolve, reject) => {
        var options = {
          hostname: config.node.host,
          port: config.node.port,
          path: '/',
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'X-IOTA-API-Version': '1',
          }
        };
        var req = http.request(options, function(res) {
          res.setEncoding('utf8');
          res.on('data', function (body) {
            body=JSON.parse(body);
            if(typeof(body)==="undefined"){
                resolve(false);
            } else if(typeof(body.balances)==="undefined"){
                resolve(false);
            } else {
                Object.keys(addresses).forEach(function(address,key){
                   addresses[address].balance=body.balances[key]; 
                });
                resolve(true);              
            }
          });
        });
        req.on('error', function(e) {
            resolve(false);
        });
        // write data to request body
        req.write('{"command": "getBalances", "addresses": ["'+Object.keys(addresses).join('","')+'"], "threshold": 100}');
        req.end();
    });
}

var autoPromote = function () {
     return new Promise((resolve, reject) => {
        if(typeof(job)!=="object" || job === null){
            if (config.general.sql){
                resolve();
            } else {
                console.log(getPrintableTime()+" - You need to provide a hash to promote");
                process.exit(1);
            }
        } else if(!iota.valid.isHash(job.hash)){
            console.log(getPrintableTime()+" - Invalid transaction to promote");
            if (config.general.sql){
                sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status` = '5' WHERE `id` = '"+job.id+"'").then(function(){resolve(false);}); 
            } else {
                process.exit(1);
            }
        } else {
        // get bundle first
        iota.api.getTransactionsObjects([job.hash], (err, res) => {
            if (err) {
                console.log(getPrintableTime()+" - Error getting transaction objects from hash:");
                console.log(err);
                if (config.general.sql){
                    sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status` = '6' WHERE `id` = '"+job.id+"'").then(function(){resolve(false);}); 
                } else {
                    process.exit(1);
                }
            } else {
                iota.api.findTransactionObjects({bundles:[res[0].bundle]},function(err,bundle){
                    if (err) {
                        console.log(getPrintableTime()+" - Unable to find transaction objects from bundle:");
                        console.log(err);
                        if (config.general.sql){
                            sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status` = '7' WHERE `id` = '"+job.id+"'").then(function(){resolve(false);}); 
                        } else {
                            process.exit(1);
                        }
                    } else {
                        bundle.sort(function(x, y){return y.attachmentTimestamp - x.attachmentTimestamp;});
                        var trails=new Array();
                        bundle.forEach((tx, index) => {
                            if(tx.currentIndex === 0) trails.push(tx.hash);
                        });
                        job.hash=trails[0];
                        isConfirmed(trails).
                            then(function (confirmed){
                                if (confirmed) {
                                    console.log(getPrintableTime()+" -> Confirmed:"+job.hash);
                                    if (config.general.sql){
                                        sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status`= '3' WHERE `id`='"+job.id+"'").then(function(){resolve()}); 
                                    } else {
                                        // we made it
                                        process.exit(0);   
                                    }
                                } else {
                                    getPromotable(trails).then(function (promotable) {
                                        if (promotable!==false){
                                          // do promote here
                                          job.hash = promotable; // update current hash to promotable one
                                          console.log(getPrintableTime()+" - Promote:"+job.hash);
                                          iota.api.promoteTransaction(job.hash, config.general.depth, config.general.minWeightMagnitude, [{
                                            address:config.spam.address,
                                            value:0,
                                            message: config.spam.message,
                                            tag:config.spam.tag,
                                          }] ,{delay:0}, (err, res) => {
                                                if (err) {
                                                    console.log(err);
                                                    console.log(getPrintableTime()+" - No spam created");
                                                    resolve();
                                                } else if (typeof(res)==="undefined"){
                                                    console.log(getPrintableTime()+" - No spam created");
                                                    resolve();
                                                } else if(typeof(res[0])==="object") {
                                                    console.log(getPrintableTime()+" - Spam:"+res[0]["hash"]);
                                                    config.general.promotions++;
                                                    if (config.general.sql){
                                                         sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `promote_count`=`promote_count`+1 WHERE `id`='"+job.id+"'").then(function(){resolve()}); 
                                                    } else {
                                                         resolve();   
                                                    }
                                                }
                                           });
                                       } else {
                                           // check balances
                                           checkBalances(bundle).then(function(result){
                                                if(result===-1){
                                                    console.log(getPrintableTime()+" - failed to check balance on outgoing address for:"+job.hash);
                                                    resolve();
                                                } else if(!result){
                                                    console.log(getPrintableTime()+" - Insufficient balance on outgoing address for:"+job.hash);
                                                    if(config.general.sql){
                                                        sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status` = '2'  WHERE `id` = '"+job.id+"'")
                                                                                .then(function(){resolve();});
                                                    } else {
                                                        resolve();
                                                    }
                                                } else {
                                                    iota.api.isReattachable(trails[(trails.length-1)], (err, res) => {
                                                        if (err) {
                                                            console.log(err);
                                                            console.log(getPrintableTime()+" - Unable to resolve reattachable state");
                                                            resolve();
                                                        } else if(res){
                                                             console.log(getPrintableTime()+" - Not Prom:"+job.hash);
                                                             console.log(getPrintableTime()+" - Reattach:"+trails[(trails.length-1)]);
                                                             // Reattach
                                                             if(config.general.reattach){
                                                                 iota.api.replayBundle(trails[(trails.length-1)],config.general.depth,config.general.minWeightMagnitude, (err, txs) => {
                                                                    if (err) {
                                                                        console.log(err);
                                                                        console.log(getPrintableTime()+" - Unable to reattach");
                                                                        resolve();
                                                                    } else if(typeof(txs)==="undefined"){
                                                                        console.log(getPrintableTime()+" - Not received reattach:"+trails[(trails.length-1)]);
                                                                        resolve(); 
                                                                    } else if(typeof(txs[0])==="undefined"){
                                                                        console.log(getPrintableTime()+" - Not received reattach"+trails[(trails.length-1)]);
                                                                        resolve();
                                                                    } else {
                                                                        console.log(getPrintableTime()+" - Reattached to:"+txs[0].hash);
                                                                        config.general.reattaches++;
                                                                        if (config.general.sql){
                                                                            sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status` = '1', `reattach_count`=`reattach_count`+1 WHERE `id` = '"+job.id+"'")
                                                                                .then(function(){resolve();}); 
                                                                        } else {
                                                                            resolve(); 
                                                                        }   
                                                                    }
                                                                 });
                                                             } else {
                                                                resolve(); 
                                                             }
                                                        } else {
                                                            if (config.general.sql){
                                                                sqlJob("UPDATE `spammer_hashes` SET `last_update` = NOW(), `status`='99' WHERE `id`='"+job.id+"'").then(function(){resolve("Error:"+job.hash);}); 
                                                            } else {
                                                                resolve("Error:"+job.hash);   
                                                            }
                                                        }
                                                    });
                                                }
                                           });
                                      }
                                     }, function (err) {
                                       reject(err);
                                     });   
                                }
                            }); // confirmed function
                    } // else error findTransactionObjects
                }); // findTransactionObjects
            }
        });
       } 
     });
}

function getPrintableTime(){
    var currentdate = new Date(); 
    return ("0"+currentdate.getHours()).slice(-2) + ":"  
                    + ("0"+currentdate.getMinutes()).slice(-2) + ":" 
                    + ("0"+currentdate.getSeconds()).slice(-2);
}

var runner = function() {
    getJob()
    .then(autoPromote)
    .then(function(result){
        if(config.general.loop){
            setTimeout(() => {  
                runner();
            }, config.general.sleeptime)
        }
    });
}

// start actual script
connectDB()
    .then(connectNode)
    .then(function(){runner();});
