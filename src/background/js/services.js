/*jshint multistr: true */

// Quicktexts operations
gqApp.service('QuicktextService', function($q, $resource, SettingsService){
    var self = this;
    self.qRes =  $resource(SettingsService.get('apiBaseURL') + 'quicktexts/:quicktextId', {quicktextId: '@id'});

    self.db = openDatabase('qt', '1.0.0', '', 2 * 1024 * 1024);
    self.db.transaction(function (tx) {
        tx.executeSql('CREATE TABLE quicktext (\
                id INTEGER PRIMARY KEY AUTOINCREMENT,\
                key VARCHAR(50) DEFAULT "",\
                title VARCHAR(250) NOT NULL,\
                shortcut VARCHAR(250) DEFAULT "",\
                subject TEXT DEFAULT "",\
                tags TEXT DEFAULT "",\
                body TEXT DEFAULT "");');
        tx.executeSql('INSERT INTO quicktext (title, shortcut, body) VALUES ("Say Hello", "h", "Hello {{to.0.first_name}},\n\n")');
        tx.executeSql('INSERT INTO quicktext (title, shortcut, body) VALUES ("Kind regards", "kr", "Kind regards,\n{{from.0.first_name}}.")');
    });

    self.quicktexts = function(){
        var deferred = $q.defer();
        self.db.transaction(function(tx){
            tx.executeSql("SELECT * FROM quicktext", [], function(tx, res) {
                var len = res.rows.length, i;
                var list = [];
                for (i = 0; i < len; i++) {
                    list.push(res.rows.item(i));
                }
                deferred.resolve(list);
            });
        });
        return deferred.promise;
    };

    // Trigger a sync operation
    self.sync = function() {
        //TODO: Make sure the user is logged in before sending anything

        // Take all quicktexts
        var qRes = $resource(SettingsService.get('apiBaseURL') + 'quicktexts/sync');

        // This will upload all quicktexts to the server
        self.quicktexts().then(function(quicktexts){
            var q = qRes();
            q.quicktexts = quicktexts;
            q.$save(function(res){
                // Saving quicktexts should respond with new quicktexts which will replace the local copies.
            });
        });
    };

    // given a string with tags give a clean list
    // remove spaces, duplicates and so on
    self._clean_tags = function(tags){
        var tArray = _.filter(tags.split(','), function(tag){
            if (tag.trim() !== ''){
                return true;
            }
        });
        tags = _.unique(_.map(tArray, function(t){ return t.trim(); })).join(', ');
        return tags;
    };

    // Copy one quicktext object to another
    self._copy = function(source, target){
        for (var k in source){
            if (k === 'tags'){
                target[k] = self._clean_tags(source[k]);
            } else {
                target[k] = source[k];
            }
        }
        return target;
    };

    // get quicktext object given an id or null
    self.get = function(id) {
        var deferred = $q.defer();
        self.db.transaction(function(tx){
            tx.executeSql("SELECT * FROM quicktext WHERE id = ?", [id], function(tx, res) {
                deferred.resolve(res.rows.item(0));
            });
        });
        return deferred.promise;
    };

    // create and try to sync
    self.create = function(qt){
        self.db.transaction(function(tx){
            tx.executeSql("INSERT INTO quicktext (key, title, subject, shortcut, tags, body) VALUES (?, ?, ?, ?, ?, ?)", [
                qt.key, qt.title, qt.subject, qt.shortcut, self._clean_tags(qt.tags), qt.body
            ]);

            var remoteQt = new self.qRes();
            remoteQt = self._copy(qt, remoteQt);
            remoteQt.$save(function(res){
                console.log(res);
            });
        });
        _gaq.push(['_trackEvent', 'quicktexts', 'create']);
    };

    // update a quicktext and try to sync
    self.update = function(qt){
        self.db.transaction(function(tx){
            tx.executeSql("UPDATE quicktext SET key = ?, title = ?, subject = ?, shortcut = ?, tags = ?, body = ? WHERE id = ?", [
                qt.key, qt.title, qt.subject, qt.shortcut, self._clean_tags(qt.tags), qt.body, qt.id
            ]);
        });
        _gaq.push(['_trackEvent', 'quicktexts', 'update']);
    };

    // delete a quicktext and try to sync
    self.delete = function(id){
        self.db.transaction(function(tx){
            tx.executeSql("DELETE FROM  quicktext WHERE id =  ?", [id]);
        });
        _gaq.push(['_trackEvent', 'quicktexts', 'delete']);
    };

    // delete all but don't delete from server
    self.deleteAll = function(){
        self.db.transaction(function(tx){
            tx.executeSql("DELETE FROM quicktext");
        });
        _gaq.push(['_trackEvent', "quicktexts", 'delete-all']);
    };


    // get all tags from a quicktext
    self.tags = function(qt){
        var retTags = [];
        _.each(qt.tags.split(","), function(tag){
            retTags.push(tag.replace(/ /g, ""));
        });
        return retTags;
    };

    // get all tags
    self.allTags = function(){
        var deferred = $q.defer();
        self.quicktexts().then(function(quicktexts){
            var tagsCount = {};
            _.each(quicktexts, function(qt){
                _.each(qt.tags.split(","), function(tag){
                    tag = tag.replace(/ /g, "");
                    if (!tag) {
                        return;
                    }
                    if (!tagsCount[tag]){
                        tagsCount[tag] = 1;
                    } else {
                        tagsCount[tag]++;
                    }
                });
            });
            deferred.resolve(tagsCount);
        });
        return deferred.promise;
    };

    // perform migration from version 0.4.3 to the new version 1.0.0
    self.migrate_043_100 = function(){
        var quicktexts = Settings.get("quicktexts");
        if (quicktexts){
            for (var i in quicktexts){
                var qt = quicktexts[i];
                qt.body = qt.body.replace("<%=", "{{");
                qt.body = qt.body.replace("%>", "}}");
                qt.body = qt.body.replace("to[0].", "to.0.");
                qt.body = qt.body.replace("from[0].", "from.0.");
                qt.key = "";
                self.create(qt);
            }
            Settings.set("quicktexts", []);
        }
    };
});

// Settings
gqApp.service('SettingsService', function(){
    var self = this;
    self.get = function(key, def){
        return Settings.get(key, def);
    };
    self.set = function(key, val){
        return Settings.set(key, val);
    };
    return self;
});

// User Profile - check if the user is logged in. Get it's info
gqApp.service('ProfileService', function(SettingsService, md5){
    var self = this;

    self.isLoggedin = false;

    self.email = '';
    self.firstName = '';
    self.lastName = '';
    self.currentSubscription = '';
    self.expirationDate = '';

    self.gravatar = function(size){
        return 'http://www.gravatar.com/avatar/' + md5.createHash(self.email);
    };

    self.reduceNumbers = function(n) {
        /* Write nice numbers. Ex: 1000 -> 1k */
        if (!n){
            return "0";
        }
        if (n < 1000){
            return n;
        }

        var mag, p;
        if (n < Math.pow(10, 6)) {
            mag = "k";
            p = Math.pow(10, 3);
        } else if (n < Math.pow(10, 8)) {
            p = Math.pow(10, 6);
            mag = "M";
        } else if (n < Math.pow(10, 11)) {
            p = Math.pow(10, 8);
            mag= "G";
        } else if (n < Math.pow(10, 14)) {
            p = Math.pow(10, 11);
            mag = "T";
        }
        return (Math.floor((n / p) * p) / p).toFixed(2) + mag;
    };

    self.words = SettingsService.get("words", 0);
    self.savedWords = self.reduceNumbers(self.words);

    self.niceTime = function(minutes){
        if (!minutes){
            return "0min";
        }
        if (minutes < 60) {
            return minutes + "min";
        }
        // 23h and 23m
        if (minutes < 60 * 24) {
            return Math.floor(minutes/60) + "h and " + minutes % 60 + "min";
        } else {
            return Math.floor(minutes / (60 * 24)) + "d, " + Math.floor(minutes % (60 * 24) / 60) + "h and " + minutes % (60 * 24) % 60 + "min";
        }
    };
    // average WPM: http://en.wikipedia.org/wiki/Words_per_minute
    self.avgWPM = 33;
    self.savedTime = self.niceTime(Math.round(self.words/self.avgWPM));

    return self;
});
