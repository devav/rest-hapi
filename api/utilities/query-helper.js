var _ = require('lodash');
var assert = require("assert");
var qs = require('qs');
var extend = require('util')._extend;

//TODO: mulit-level/multi-priority sorting (i.e. sort first by lastName, then by firstName) implemented via comma seperated sort list
//TODO: support $embed for quick embedding and "populate" for detailed, mongoose specific population
//TODO: support both $term search and mongoose $text search

module.exports = {
  createMongooseQuery: function (model, query, mongooseQuery, Log) {
    Log.debug("query before:", query);
    //(email == 'test@user.com' && (firstName == 'test2@user.com' || firstName == 'test4@user.com')) && (age < 15 || age > 30)
    //LITERAL
    //{
    //  and: {
    //    email: {
    //      equal: 'test@user.com',
    //    },
    //    or: {
    //      firstName: {
    //        equal: ['test2@user.com', 'test4@user.com']
    //      }
    //    },
    //    age: {
    //      gt: '15',
    //      lt: '30'
    //    }
    //  }
    //{
    // and[email][equal]=test@user.com&and[or][firstName][equal]=test2@user.com&and[or][firstName][equal]=test4@user.com&and[age][gt]=15
    //ABBREVIATED
    //{
    //  email:'test@user.com',
    //  firstName: ['test2@user.com', 'test4@user.com'],
    //  age: {
    //    $or: {
    //      $gt: '15',
    //      $lt: '30'
    //    }
    //  }
    //}
    // [email]=test@user.com&[firstName]=test2@user.com&[firstName]=test4@user.com&[age][gt]=15&[age][lt]=30

    var modelMethods = model.schema.methods;
    
    var queryableFields = this.getQueryableFields(model, Log);

    mongooseQuery = this.setOffsetIfExists(query, mongooseQuery, Log);

    mongooseQuery = this.setLimitIfExists(query, mongooseQuery, Log);

    // var defaultWhere = this.createDefaultWhere(query, queryableFields, Log);

    //mongooseQuery = this.setTermSearch(query, mongooseQuery, queryableFields, defaultWhere, Log);

    var attributesFilter = this.createAttributesFilter(query, model, Log);

    if (modelMethods.routeOptions) {
      var result = this.populateEmbeddedDocs(query, mongooseQuery, attributesFilter,
        modelMethods.routeOptions.associations, Log);
      mongooseQuery = result.mongooseQuery;
      attributesFilter = result.attributesFilter;
    }

    //mongooseQuery = this.setSortFields(query, mongooseQuery, modelMethods.routeOptions.associations, Log);

    mongooseQuery.select(attributesFilter);


    Log.debug("query after:", query);
    mongooseQuery.where(query);
    return mongooseQuery;
  },

  getReadableFields: function (model, Log) {
    assert(model, "requires `model` parameter");

    var readableFields = [];

    var fields = model.schema.paths;

    for (var fieldName in fields) {
      var field = fields[fieldName].options;
      if (!field.exclude) {
        readableFields.push(fieldName);
      }
    }

    readableFields.pop();//EXPL: omit the internal version number
    return readableFields;
  },

  /**
   * Crawls the model's tableAttributes for queryable fields
   * @param {Object} A sequelize model object, specifically uses the tableAttributes property on that object.
   * @returns {string[]} An array of queryable field names
   */
  getQueryableFields: function (model, Log) {
    assert(model, "requires `model` parameter");
    var queryableFields = [];
    var fields = model.schema.paths;

    for (var fieldName in fields) {
      var field = fields[fieldName].options;

      if (field.queryable && !field.exclude) {
        queryableFields.push(fieldName);
      }
    }

    return queryableFields;
  },

  setOffsetIfExists: function (query, mongooseQuery, Log) {
    if (query.$skip) {
      mongooseQuery.skip(query.$skip);
      delete query.$skip;
    }
    return mongooseQuery;
  },

  setLimitIfExists: function (query, mongooseQuery, Log) {
    //TODO: possible default limit of 20?
    if (query.$limit) {
      mongooseQuery.limit(query.$limit);
      delete query.$limit;
    }
    return mongooseQuery;
  },

  setSortFields: function (query, mongooseQuery, modelAssociations, Log) {
    if (query.sort) {
      var fieldSorts = [];

      var sortFields = query.sort.split(",");

      for (var sortFieldIndex in sortFields) {
        var sortField = sortFields[sortFieldIndex];

        var queryAssociations = [];
        var order = sortField[0];
        sortField = sortField.substring(1);
        sortField = sortField.split(".");

        //EXPL: support sorting through nested associations
        if (sortField.length > 1) {
          var association = null;
          while (sortField.length > 1) {
            association = sortField.shift();
            queryAssociations.push(modelAssociations[association].include);
            modelAssociations = modelAssociations[association].include.model.schema.methods.routeOptions.associations;
          }
          sortField = sortField[0];
        } else {
          sortField = sortField[0];
        }

        var sortQuery = null;
        if (order == "-") {
          //EXPL: - means descending.
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            sortQuery.push('DESC');
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField, "DESC"]);
          }
        } else if (order == "+") {
          //EXPL: + means ascending.
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField]);
          }
        } else {
          //EXPL: default to ascending if there is no - or +
          if (queryAssociations) {
            sortQuery = queryAssociations;
            sortQuery.push(sortField);
            fieldSorts.push(sortQuery);
          } else {
            fieldSorts.push([sortField]);
          }
        }
      }

      //EXPL: remove from the query to remove conflicts.
      delete query.sort;

      mongooseQuery.order = fieldSorts;
    }

    return mongooseQuery;
  },

  createDefaultWhere: function (query, defaultSearchFields, Log) {

    //TODO: update this to handle more complex queries
    //EX: query = {"or-like-title":"Boat","or-not-description":"boat"
    //should result in
    //$or: [
    //{
    //  title: {
    //    $like: 'Boat'
    //  }
    //},
    //{
    //  description: {
    //    $notIn: 'boat'
    //  }
    //}
    //]

    //query = "or[]

    var defaultWhere = {};

    // function parseSearchFieldValue(searchFieldValue)
    // {
    //   if (_.isString(searchFieldValue)) {
    //     switch (searchFieldValue.toLowerCase()) {
    //       case "null":
    //         return null;
    //         break;
    //       case "true":
    //         return true;
    //         break;
    //       case "false":
    //         return false;
    //         break;
    //       default:
    //         return searchFieldValue;
    //     }
    //   } else if (_.isArray(searchFieldValue)) {
    //     searchFieldValue = _.map(searchFieldValue, function (item) {
    //       switch (item.toLowerCase()) {
    //         case "null":
    //           return null;
    //           break;
    //         case "true":
    //           return true;
    //           break;
    //         case "false":
    //           return false;
    //           break;
    //         default:
    //           return item;
    //       }
    //     });
    //     return {$or: searchFieldValue}; //NOTE: Here searchFieldValue is an array.
    //   }
    // }

    if (defaultSearchFields) {
      for (var queryField in query) {
        var index = defaultSearchFields.indexOf(queryField);
        if (index >= 0) { //EXPL: queryField is for basic search value

          var defaultSearchField = defaultSearchFields[index];

          var searchFieldValue = query[defaultSearchField];

          defaultWhere[defaultSearchField] = parseSearchFieldValue(searchFieldValue);

        } else { //EXPL: queryField includes options

          var defaultSearchField = null;
          var searchFieldValue = query[queryField];
          queryField = queryField.split('-');
          if (queryField.length > 1) {
            defaultSearchField = queryField[1];
          }
          queryField = queryField[0];

          if (defaultSearchField) {
            searchFieldValue = parseSearchFieldValue(searchFieldValue);
            switch (queryField) {
              case "not": //EXPL: allows for omitting objects
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                if (_.isArray(searchFieldValue)) {
                  defaultWhere[defaultSearchField]["$notIn"] = searchFieldValue;
                } else {
                  defaultWhere[defaultSearchField]["$notIn"] = [searchFieldValue];
                }
                break;
              case "max": //EXPL: query for max search value
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                defaultWhere[defaultSearchField]["$gte"] = searchFieldValue;
                break;
              case "min": //EXPL: query for min search value
                if (!defaultWhere[defaultSearchField]) {
                  defaultWhere[defaultSearchField] = {};
                }
                defaultWhere[defaultSearchField]["$lte"] = searchFieldValue;
                break;
              case "or":  //EXPL: allows for different properties to be ORed together
                if (!defaultWhere["$or"]) {
                  defaultWhere["$or"] = {};
                }
                defaultWhere["$or"][defaultSearchField] = searchFieldValue;
                break;
              default:
                break;
            }
          }
        }
      }
    }

    return defaultWhere;
  },

  // setTermSearch: function (query, mongooseQuery, defaultSearchFields, defaultWhere, Log) {
  //   //EXPL: add the term as a regex search
  //   if (query.term) {
  //     var searchTerm = query.term;
  //     //EXPL: remove the "term" from the query
  //     delete query.term;
  //
  //     var fieldSearches = undefined;
  //
  //     if (query.searchFields) {
  //       var searchFields = query.searchFields.split(",");
  //
  //       fieldSearches = [];
  //
  //       //EXPL: add field searches only for those in the query.fields
  //       for (var fieldIndex in searchFields) {
  //         var field = searchFields[fieldIndex];
  //         var fieldSearch = {}
  //         fieldSearch[field] = {$like: "%" + searchTerm + "%"}
  //         fieldSearches.push(fieldSearch)
  //       }
  //
  //       delete query.searchFields; //EXPL: remove to avoid query conflicts.
  //     } else {
  //       var fieldSearches = [];
  //
  //       //EXPL: add ALL the fields as search fields.
  //       if (defaultSearchFields) {
  //         for (var defaultSearchFieldIndex in defaultSearchFields) {
  //           var defaultSearchField = defaultSearchFields[defaultSearchFieldIndex];
  //
  //           var searchObject = {};
  //
  //           searchObject[defaultSearchField] = {$like: "%" + searchTerm + "%"}
  //
  //           fieldSearches.push(searchObject);
  //         }
  //       }
  //     }
  //
  //     mongooseQuery.where = {
  //       $and: [{
  //         $or: fieldSearches
  //       },
  //         defaultWhere
  //       ]
  //     };
  //   } else {
  //     mongooseQuery.where = defaultWhere;
  //   }
  //
  //   return mongooseQuery;
  // },

  populateEmbeddedDocs: function (query, mongooseQuery, attributesFilter, associations, Log) {
    if (query.$embed) {
      var embedStrings = query.$embed.split(",");
      embedStrings.forEach(function(embed) {
        Log.debug("query embed:", embed);
        var embeds = embed.split(".");
        var populate = {};
        var populatePath = "";
        var baseLevel = true;
        var association = {};
        var path = {};

        populate = nestPopulate(populate, 0, embeds, associations, Log);
        Log.debug("populate:", populate);

        mongooseQuery.populate(populate);

        Log.debug("attributesFilter before:", attributesFilter);
        attributesFilter = attributesFilter + ' ' + populate.path;
        Log.debug("attributesFilter after:", attributesFilter);
      });
      delete query.$embed;
    }
    return { mongooseQuery: mongooseQuery, attributesFilter: attributesFilter };
  },

  createAttributesFilter: function (query, model, Log) {
    var attributesFilter = [];
    var fields = model.schema.paths;
    var fieldNames = [];

    if (query.fields) {
      fieldNames = query.fields;
    } else {
      fieldNames = Object.keys(fields)
    }

    var associations = Object.keys(model.schema.methods.routeOptions.associations);

    for (var i = 0; i < fieldNames.length; i++) {
      var fieldName = fieldNames[i];
      var field = fields[fieldName].options;
      var isAssociation = associations.indexOf(fields[fieldName].path);

      if (!field.exclude && isAssociation < 0) {
        attributesFilter.push(fieldName);
      }
    }

    i = attributesFilter.indexOf("__v");//EXPL: omit the internal version number

    if(i != -1) {
      attributesFilter.splice(i, 1);
    }

    return attributesFilter.toString().replace(/,/g,' ');
  }
};

function nestPopulate(populate, index, embeds, associations, Log) {
  Log.debug("populate:", populate);
  Log.debug("index:", index);
  Log.debug("embeds:", embeds);
  Log.debug("associations:", associations);
  var embed = embeds[index];
  var association = associations[embed];
  var populatePath = "";
  if (association.type === "MANY_MANY") {
    populatePath = embed + '.' + association.model;
  } else {
    populatePath = embed;
  }
  if (index < embeds.length - 1) {
    associations = association.include.model.schema.methods.routeOptions.associations;
    populate = nestPopulate(populate, index + 1, embeds, associations, Log);
    populate.populate = extend({}, populate);//EXPL: prevent circular reference
    populate.path = populatePath;
    Log.debug("populate:", populate);
    return populate;
  } else {
    populate.path = populatePath;
    Log.debug("populate:", populate);
    return populate;
  }
}