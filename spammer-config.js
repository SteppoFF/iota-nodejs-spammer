var config = {};
config.node = {
    schema:"http",
    host:"localhost",
    port:"14265"
};

config.database = {
    host:"localhost",
    user:"user",
    password:"password",
    database:"database"
};

config.spam = {
    address:"COOLSPAMMER9999999999999999999999999999999999999999999999999999999999999999999999",
    message:"",
    tag:"SPAM99999999999999999999999",
};

config.general = {
    loop:false,             // run promoter in loop mode
    sql:false,              // run promoter as sql slave
    sleeptime:500,          // current used sleeptime
    sleeptimebase:500,      // Base time between promotion cycles
    minWeightMagnitude:14,  // minWeightMagnitude to use for PoW
    depth:3,                // depth for finding transactions to approve
    reattach:false,         // perform reattaches
    promotions:0,           // number of performed promotions
    reattaches:0,           // number of performed reattaches
    start:new Date()        // start datetime for this script
};

module.exports = config;
