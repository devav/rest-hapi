var Joi = require('joi');
var _ = require('lodash');
var assert = require('assert');
var joiSequelizeHelper = require('./joi-sequelize-helper')();
var queryHelper = require('./query-helper');
var chalk = require('chalk');

module.exports = function (logger, mongoose, server) {
  var logger = logger.bind(chalk.gray('rest-helper-factory'));

  var HandlerHelper = require('./handler-helper-factory')(mongoose, server);

  var headersValidation = Joi.object({
    'authorization': Joi.string().required()
  }).options({allowUnknown: true});

  return {
    defaultHeadersValidation: headersValidation,
    generateRoutes: function (server, model, options) { //TODO: generate multiple DELETE routes at /RESOURCE and at /RESOURCE/{ownerId}/ASSOCIATION that take a list of Id's as a payload
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      var Log = logger.bind(chalk.gray(collectionName));

      options = options || {};

      if (modelMethods.routeOptions.allowRead !== false) {
        this.generateListEndpoint(server, model, options, Log);
        this.generateFindEndpoint(server, model, options, Log);
      }

      if (modelMethods.routeOptions.allowCreate !== false) {
        this.generateCreateEndpoint(server, model, options, Log);
      }

      if (modelMethods.routeOptions.allowUpdate !== false) {
        this.generateUpdateEndpoint(server, model, options, Log);
      }

      if (modelMethods.routeOptions.allowDelete !== false) {
        this.generateDeleteEndpoint(server, model, options, Log);
      }

      if (modelMethods.routeOptions.associations) {
        for (var associationName in modelMethods.routeOptions.associations) {
          var association = modelMethods.routeOptions.associations[associationName];

          if (association.type == "MANY_MANY" || association.foreignField) {
            if (association.allowAddOne !== false) {
              this.generateAssociationAddOneEndpoint(server, model, association, options, Log);
            }

            if (association.allowRemoveOne !== false) {
              this.generateAssociationRemoveOneEndpoint(server, model, association, options, Log);
            }

            if (association.allowAddMany !== false) {
              this.generateAssociationAddManyEndpoint(server, model, association, options, Log);
            }

            if (association.allowRead !== false) {
              this.generateAssociationGetAllEndpoint(server, model, association, options, Log);
            }
          }
        }
      }

      if(modelMethods.routeOptions && modelMethods.routeOptions.extraEndpoints){
        for(var extraEndpointIndex in modelMethods.routeOptions.extraEndpoints){
          var extraEndpointFunction = modelMethods.routeOptions.extraEndpoints[extraEndpointIndex];

          extraEndpointFunction(server, model, options, Log);
        }
      }
    },
    generateListEndpoint: function (server, model, options, Log) {
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      Log = Log.bind("List");
      options = options || {};

      Log.note("Generating List endpoint for " + collectionName);

      var resourceAliasForRoute;

      if (modelMethods.routeOptions) {
        resourceAliasForRoute = modelMethods.routeOptions.alias || model.modelName;
      } else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateListHandler(model, options, Log);

      var queryValidation = {
        offset: Joi.number().integer().min(0).optional()
          .description('The number of records to skip in the database. This is typically used in pagination.'),
        limit: Joi.number().integer().min(0).optional()
          .description('The maximum number of records to return. This is typically used in pagination.')
      };

      var queryableFields = queryHelper.getQueryableFields(model, Log);

      var readableFields = queryHelper.getReadableFields(model, Log);

      if (queryableFields) {
        queryValidation.fields = Joi.string().optional()//TODO: make enumerated array.
          .description('A list of basic fields to be included in each resource. Valid values include: ' + readableFields);
        queryValidation.term = Joi.string().optional()
          .description('A generic search parameter. This can be refined using the `searchFields` parameter. Valid values include: ' + queryableFields);
        queryValidation.searchFields = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of fields to apply the \"term\" search parameter to. If this parameter is not included, the \"term\" search parameter is applied to all searchable fields. Valid values include: ' + queryableFields);
        queryValidation.sort = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of sort fields. Prepending \'+\' to the field name indicates it should be sorted ascending, while \'-\' indicates descending. The default sort direction is \'ascending\' (lowest value to highest value).');


        _.each(queryableFields, function (fieldName) {
          queryValidation[fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
          queryValidation["min-" + fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
          queryValidation["max-" + fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
          queryValidation["not-" + fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
          queryValidation["or-" + fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
        })
      }

      if (modelMethods.routeOptions && modelMethods.routeOptions.associations) {
        queryValidation.embed = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of complex object properties to populate. Valid values include ' + Object.keys(modelMethods.routeOptions.associations));
      }

      var readModel = joiSequelizeHelper.generateJoiReadModel(model);

      server.route({
        method: 'GET',
        path: '/' + resourceAliasForRoute,
        config: {
          handler: handler,
          auth: "token",
          description: 'Get a list of ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            // query: queryValidation,
            query: Joi.any(),
            headers: Joi.object({
              'authorization': Joi.string().required()
            }).options({allowUnknown: true})
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource(s) was/were found successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            // schema: Joi.array().items(readModel || Joi.object().unknown().optional())
            schema: Joi.array().items(Joi.any())//TODO: proper validation
          }
        }
      });
    },
    generateFindEndpoint: function (server, model, options, Log) {
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      Log = Log.bind("Find");
      Log.note("Generating Find endpoint for " + collectionName);

      var resourceAliasForRoute;

      if (modelMethods.routeOptions) {
        resourceAliasForRoute = modelMethods.routeOptions.alias || model.modelName;
      } else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateFindHandler(model, options, Log);

      var queryValidation = {};

      var readableFields = queryHelper.getReadableFields(model, Log);

      if (readableFields) {
        queryValidation.fields = Joi.string().optional()//TODO: make enumerated array.
          .description('A list of basic fields to be included in each resource. Valid values include: ' + readableFields);
      }

      if (modelMethods.routeOptions && modelMethods.routeOptions.associations) {
        queryValidation.embed = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of complex object properties to populate. Valid values include ' + Object.keys(modelMethods.routeOptions.associations));
      }

      var readModel = modelMethods.readModel || joiSequelizeHelper.generateJoiReadModel(model);

      server.route({
        method: 'GET',
        path: '/' + resourceAliasForRoute + '/{id}',
        config: {
          handler: handler,
          auth: "token",
          description: 'Get a specific ' + collectionName,
          tags: ['api', collectionName],
          cors: true,
          validate: {
            query: queryValidation,
            params: {
              id: Joi.string().required()//TODO: validate that id is an ObjectId
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource(s) was/were found successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: readModel || Joi.object().unknown().optional()
          }
        }
      });
    },
    generateCreateEndpoint: function (server, model, options, Log) {
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      Log = Log.bind("Create");
      Log.note("Generating Create endpoint for " + collectionName);

      options = options || {};

      var resourceAliasForRoute;

      if (modelMethods.routeOptions) {
        resourceAliasForRoute = modelMethods.routeOptions.alias || model.modelName;
      } else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateCreateHandler(model, options, Log);

      var createModel = modelMethods.createModel || joiSequelizeHelper.generateJoiCreateModel(model);

      var readModel = modelMethods.readModel || joiSequelizeHelper.generateJoiReadModel(model);

      server.route({
        method: 'POST',
        path: '/' + resourceAliasForRoute,
        config: {
          handler: handler,
          //auth: "token",
          cors: true,
          description: 'Create a new ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            payload: createModel,
            // headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 201, message: 'The resource was created successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            // schema: readModel || Joi.object().unknown().optional()
            schema: Joi.any()
          }
        }
      });
    },
    generateDeleteEndpoint: function (server, model, options, Log) {
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      Log = Log.bind("Delete");
      Log.note("Generating Delete endpoint for " + collectionName);

      options = options || {};

      var resourceAliasForRoute;

      if (modelMethods.routeOptions) {
        resourceAliasForRoute = modelMethods.routeOptions.alias || model.modelName;
      } else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateDeleteHandler(model, options, Log);

      server.route({
        method: 'DELETE',
        path: '/' + resourceAliasForRoute + "/{id}",
        config: {
          handler: handler,
          auth: "token",
          cors: true,
          description: 'Create a new ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            params: {
              id: Joi.string().required(),//TODO: validate that id is an ObjectId
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource was deleted successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            //schema: model.readModel ? model.readModel : Joi.object().unknown().optional()
          }
        }
      });
    },
    generateUpdateEndpoint: function (server, model, options, Log) {
      var modelMethods = model.schema.methods;
      var collectionName = modelMethods.collectionDisplayName || model.modelName;
      Log = Log.bind("Update");
      Log.note("Generating Update endpoint for " + collectionName);

      options = options || {};

      var resourceAliasForRoute;

      if (modelMethods.routeOptions) {
        resourceAliasForRoute = modelMethods.routeOptions.alias || model.modelName;
      } else {
        resourceAliasForRoute = model.modelName;
      }

      var handler = HandlerHelper.generateUpdateHandler(model, options, Log);

      var updateModel = modelMethods.updateModel || joiSequelizeHelper.generateJoiUpdateModel(model);

      server.route({
        method: 'PUT',
        path: '/' + resourceAliasForRoute + '/{id}',
        config: {
          handler: handler,
          auth: "token",
          cors: true,
          description: 'Update a ' + collectionName,
          tags: ['api', collectionName],
          validate: {
            params: {
              id: Joi.string().required(),//TODO: validate that id is an ObjectId
            },
            payload: updateModel,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The resource was updated successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            //schema: model.readModel ? model.readModel : Joi.object().unknown().optional()
          }
        }
      });
    },
    generateAssociationAddOneEndpoint: function (server, ownerModel, association, options, Log) {
      var ownerMethods = ownerModel.schema.methods;
      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerMethods.collectionDisplayName || ownerModel.modelName;
      Log = Log.bind("AddOne");
      Log.note("Generating addOne association endpoint for " + ownerModelName + " -> " + associationName);


      // Log.debug(association);

      assert(ownerMethods.routeOptions);
      assert(ownerMethods.routeOptions.associations);

      assert(association);

      options = options || {};

      var ownerAlias = ownerMethods.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = HandlerHelper.generateAssociationAddOneHandler(ownerModel, association, options, Log);

      var payloadValidation;

      if (association.include && association.include.through) {
        payloadValidation = joiSequelizeHelper.generateJoiAssociationModel(association.include.through).allow(null);
      }

      server.route({
        method: 'PUT',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}",
        config: {
          handler: handler,
          auth: "token",
          cors: true,
          description: 'Add a single ' + associationName + ' to a ' + ownerModelName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.string().required(),//TODO: validate that id is an ObjectId
              childId: Joi.string().required()//TODO: validate that id is an ObjectId
            },
            payload: payloadValidation,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was added successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {
                  code: 401,
                  message: 'The authentication header was missing/malformed, or the token has expired.'
                },
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      });
    },
    generateAssociationRemoveOneEndpoint: function (server, ownerModel, association, options, Log) {
      var ownerMethods = ownerModel.schema.methods;
      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerMethods.collectionDisplayName || ownerModel.modelName;
      Log = Log.bind("RemoveOne");
      Log.note("Generating removeOne association endpoint for " + ownerModelName + " -> " + associationName);
      

      assert(ownerMethods.routeOptions);
      assert(ownerMethods.routeOptions.associations);

      assert(association);

      options = options || {};

      var ownerAlias = ownerMethods.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = options.handler ? options.handler : HandlerHelper.generateAssociationRemoveOneHandler(ownerModel, association, options, Log);

      server.route({
        method: 'DELETE',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias + "/{childId}",
        config: {
          handler: handler,
          auth: "token",
          cors: true,
          description: 'Removes a single ' + associationName + ' from a ' + ownerModelName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.string().required(),//TODO: validate that id is an ObjectId
              childId: Joi.string().required()//TODO: validate that id is an ObjectId
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was deleted successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      });
    },
    generateAssociationAddManyEndpoint: function (server, ownerModel, association, options, Log) {
      var ownerMethods = ownerModel.schema.methods;
      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerMethods.collectionDisplayName || ownerModel.modelName;
      Log = Log.bind("AddMany");
      Log.note("Generating addMany association endpoint for " + ownerModelName + " -> " + associationName);

      assert(ownerMethods.routeOptions);
      assert(ownerMethods.routeOptions.associations);

      assert(association);

      options = options || {};

      var ownerAlias = ownerMethods.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var handler = options.handler ? options.handler : HandlerHelper.generateAssociationAddManyHandler(ownerModel, association, options, Log);

      var payloadValidation;
      
      if (association.include && association.include.through) {
        payloadValidation = joiSequelizeHelper.generateJoiAssociationModel(association.include.through);
        payloadValidation = payloadValidation.keys({
          childId: Joi.string()//TODO: validate that id is an ObjectId
        });
        payloadValidation = Joi.array().items(payloadValidation).required();
      } else {
        payloadValidation = Joi.array().items(Joi.string());//TODO: validate that id is an ObjectId
      }

      server.route({
        method: 'POST',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias,
        config: {
          handler: handler,
          auth: "token",
          cors: true,
          description: 'Sets multiple ' + associationName + ' for a ' + ownerModelName,
          tags: ['api', associationName, ownerModelName],
          validate: {
            params: {
              ownerId: Joi.string().required()//TODO: validate that id is an ObjectId
            },
            payload: payloadValidation,
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 204, message: 'The association was set successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {}
        }
      })
    },
    generateAssociationGetAllEndpoint: function (server, ownerModel, association, options, Log) {
      var ownerMethods = ownerModel.schema.methods;
      var associationName = association.include.as || association.include.model.modelName;
      var ownerModelName = ownerMethods.collectionDisplayName || ownerModel.modelName;
      Log = Log.bind("GetAll");
      Log.note("Generating list association endpoint for " + ownerModelName + " -> " + associationName);

      assert(ownerMethods.routeOptions);
      assert(ownerMethods.routeOptions.associations);

      assert(association);

      options = options || {};

      var ownerAlias = ownerMethods.routeOptions.alias || ownerModel.modelName;
      var childAlias = association.alias || association.include.model.modelName;

      var childModel = association.include.model;
      var childModelName = childModel.collectionDisplayName || childModel.modelName;

      var handler = options.handler ? options.handler : HandlerHelper.generateAssociationGetAllHandler(ownerModel, association, options, Log);

      var queryValidation = {
        offset: Joi.number().integer().min(0).optional()
          .description('The number of records to skip in the database. This is typically used in pagination.'),
        limit: Joi.number().integer().min(0).optional()
          .description('The maximum number of records to return. This is typically used in pagination.')
      };

      var queryableFields = queryHelper.getQueryableFields(childModel, Log);

      if (queryableFields) {
        queryValidation.fields = Joi.string().optional()//TODO: make enumerated array.
          .description('A list of basic fields to be included in each resource. Valid values include: ' + childModel.queryableFields);
        queryValidation.term = Joi.string().optional()
          .description('A generic search parameter. This can be refined using the `searchFields` parameter. Valid values include: ' + childModel.queryableFields);
        queryValidation.searchFields = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of fields to apply the \"term\" search parameter to. If this parameter is not included, the \"term\" search parameter is applied to all searchable fields. Valid values include: ' + childModel.queryableFields);
        queryValidation.sort = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of sort fields. Prepending \'+\' to the field name indicates it should be sorted ascending, while \'-\' indicates descending. The default sort direction is \'ascending\' (lowest value to highest value).');

        _.each(queryableFields, function (fieldName) {
          queryValidation[fieldName] = Joi.string().optional()
          queryValidation["not-" + fieldName] = Joi.alternatives().try(Joi.string().optional(), Joi.array().items(Joi.string()));
        })
      }

      if (childModel.routeOptions && childModel.routeOptions.associations) {
        queryValidation.embed = Joi.string().optional()//TODO: make enumerated array.
          .description('A set of complex object properties to populate. Valid values include ' + Object.keys(childModel.routeOptions.associations));
      }

      server.route({
        method: 'GET',
        path: '/' + ownerAlias + '/{ownerId}/' + childAlias,
        config: {
          handler: handler,
          auth: "token",
          description: 'Gets all of the ' + childModelName + ' for a ' + ownerModelName,
          tags: ['api', childModelName, ownerModelName],
          validate: {
            query: queryValidation,
            params: {
              ownerId: Joi.string().required()//TODO: validate for ObjectId
            },
            headers: headersValidation
          },
          plugins: {
            'hapi-swagger': {
              responseMessages: [
                {code: 200, message: 'The association was set successfully.'},
                {code: 400, message: 'The request was malformed.'},
                {code: 401, message: 'The authentication header was missing/malformed, or the token has expired.'},
                {code: 404, message: 'There was no resource found with that ID.'},
                {code: 500, message: 'There was an unknown error.'},
                {code: 503, message: 'There was a problem with the database.'}
              ]
            }
          },
          response: {
            schema: Joi.array().items(childModel.readModel ? childModel.readModel : Joi.object().unknown().optional())
          }
        }
      });
    },
  }
};
